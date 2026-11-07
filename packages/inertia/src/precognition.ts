import type { NestInterceptor, Type } from '@nestjs/common';
import { FORBIDDEN_KEYS } from './constants.js';
import { InertiaConfigurationError, InertiaRequestError } from './errors.js';
import type { InertiaHeaderLimits } from './request.js';
import { hasControlCharacter } from './text.js';
import type { InertiaErrors } from './validation-types.js';

/**
 * Precognition wire names from the Inertia v3 protocol specification
 * (https://inertiajs.com/docs/v3/core-concepts/the-protocol, request and
 * response headers) and the `laravel-precognition` 2.1.1 client that
 * `@inertiajs/core` 3.10.0 bundles: it sends `Precognition: true` and an
 * optional comma-joined `Precognition-Validate-Only`, rejects any response
 * without `Precognition: true`, treats `204` + `Precognition-Success: true` as
 * a pass and reads `errors` from a `422` JSON body.
 */
export const PrecognitionHeader = Object.freeze({
  precognition: 'Precognition',
  validateOnly: 'Precognition-Validate-Only',
  success: 'Precognition-Success',
} as const);

/** Outcome of a schema validator; `@nestvexa/forms` adapters return this shape. */
export type PrecognitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: InertiaErrors };

/**
 * Structural schema validator. Any `@nestvexa/forms` `SchemaAdapter`
 * (`zodAdapter`, `classValidatorAdapter`, `customAdapter`) satisfies it
 * without this package importing `@nestvexa/forms`.
 */
export interface PrecognitionSchema {
  validate(
    input: unknown,
  ): PrecognitionResult | PromiseLike<PrecognitionResult>;
}

/** Function validator: return field errors, or `undefined` when the input passes. */
export type PrecognitionCheck = (
  input: unknown,
  request: object,
) => InertiaErrors | undefined | PromiseLike<InertiaErrors | undefined>;

export type PrecognitionValidator = PrecognitionSchema | PrecognitionCheck;

/** A Nest interceptor class (created through the module injector) or instance. */
export type PrecognitionInterceptor = Type<NestInterceptor> | NestInterceptor;

export interface PrecognitiveOptions {
  /**
   * Reads the data to validate. Default: the query for GET/HEAD/DELETE (where
   * the official client sends it) and the parsed body otherwise, with
   * multer-style uploaded files (`request.file`, `request.files`) merged in
   * under their field names.
   */
  readonly input?: (request: object) => unknown;
  /**
   * Interceptors that prepare a Precognition request before it is validated,
   * in order. Route interceptors run after the Inertia interceptor, so a
   * multipart body is not parsed yet when Precognition answers; pass the
   * route's body parser here (for example `FileInterceptor('avatar')` from
   * `@nestjs/platform-express`) to validate the files the official client
   * sends after `validateFiles()`. They run only for Precognition requests
   * and must call `next.handle()`; ordinary submissions use the route's own
   * interceptors.
   */
  readonly interceptors?: readonly PrecognitionInterceptor[];
}

/** @internal Route metadata written by `@Precognitive`. */
export interface PrecognitionMetadata {
  readonly validator: PrecognitionValidator;
  readonly input: ((request: object) => unknown) | undefined;
  readonly interceptors: readonly PrecognitionInterceptor[];
}

/** Parsed Precognition request headers. */
export interface PrecognitionRequestInfo {
  readonly precognitive: boolean;
  /**
   * Fields named by `Precognition-Validate-Only`; `undefined` when the header
   * is absent (validate everything). A present but empty header selects no
   * field, as in Laravel's `filterPrecognitiveRules`.
   */
  readonly only: readonly string[] | undefined;
}

function headerValue(request: object, name: string): unknown {
  const headers = (request as { headers?: unknown }).headers;
  return typeof headers === 'object' && headers !== null
    ? (headers as Record<string, unknown>)[name.toLowerCase()]
    : undefined;
}

/** True only for `Precognition: true`, the value the official client sends. */
export function isPrecognitionRequest(request: object): boolean {
  const value = headerValue(request, PrecognitionHeader.precognition);
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

/**
 * Parses the Precognition headers with the adapter's header limits. A
 * malformed `Precognition-Validate-Only` (repeated, oversized, control
 * characters, empty or prototype path segments) is a 400.
 */
export function parsePrecognitionRequest(
  request: object,
  limits: InertiaHeaderLimits,
): PrecognitionRequestInfo {
  if (!isPrecognitionRequest(request))
    return { precognitive: false, only: undefined };
  const name = PrecognitionHeader.validateOnly;
  const raw = headerValue(request, name);
  if (raw === undefined) return { precognitive: true, only: undefined };
  if (
    typeof raw !== 'string' ||
    raw.length > limits.headerLength ||
    hasControlCharacter(raw)
  )
    throw new InertiaRequestError(name);
  const only = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (only.length > limits.listEntries) throw new InertiaRequestError(name);
  for (const entry of only) {
    if (entry.length > limits.entryLength) throw new InertiaRequestError(name);
    for (const segment of entry.split('.'))
      if (segment === '' || FORBIDDEN_KEYS.has(segment))
        throw new InertiaRequestError(name);
  }
  return { precognitive: true, only };
}

/**
 * True when error key `key` belongs to the validate-only field `field`: the
 * same path, a nested path below it, or a match where `*` stands for exactly
 * one segment (`items.*.name` selects `items.0.name`).
 */
function belongsTo(key: string, field: string): boolean {
  const keys = key.split('.');
  const fields = field.split('.');
  if (fields.length > keys.length) return false;
  return fields.every(
    (segment, index) => segment === '*' || segment === keys[index],
  );
}

/** Keeps only the errors of the requested fields (all of them without a list). */
export function selectPrecognitionErrors(
  errors: Readonly<Record<string, readonly string[]>>,
  only: readonly string[] | undefined,
): Record<string, string[]> {
  const selected: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(errors))
    if (only === undefined || only.some((field) => belongsTo(key, field)))
      selected[key] = [...messages];
  return selected;
}

export function isPrecognitionSchema(
  value: unknown,
): value is PrecognitionSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { validate?: unknown }).validate === 'function'
  );
}

/** @internal Runs a validator and returns its errors (`undefined` when valid). */
export async function runPrecognitionValidator(
  validator: PrecognitionValidator,
  input: unknown,
  request: object,
): Promise<InertiaErrors | undefined> {
  if (typeof validator === 'function') return validator(input, request);
  const result: unknown = await validator.validate(input);
  if (typeof result !== 'object' || result === null)
    throw new InertiaConfigurationError(
      'Precognition schema returned an invalid result',
    );
  const { ok, errors } = result as { ok?: unknown; errors?: unknown };
  if (ok === true) return undefined;
  if (ok === false && typeof errors === 'object' && errors !== null)
    return errors as InertiaErrors;
  throw new InertiaConfigurationError(
    'Precognition schema returned an invalid result',
  );
}

/** True for a multer-style uploaded file (`fieldname` plus file metadata). */
function isUploadedFile(
  value: unknown,
): value is { readonly fieldname: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { fieldname?: unknown }).fieldname === 'string'
  );
}

/**
 * Uploaded files by field name, from multer's `request.file` (one file),
 * `request.files` as an array (`array()`/`any()`: a list per field) or as a
 * record (`fields()`). Prototype keys are never produced.
 */
function uploadedFiles(request: object): Record<string, unknown> | undefined {
  const { file, files } = request as { file?: unknown; files?: unknown };
  const result: Record<string, unknown> = {};
  let found = false;
  const put = (field: string, value: unknown) => {
    if (FORBIDDEN_KEYS.has(field)) return;
    result[field] = value;
    found = true;
  };
  if (Array.isArray(files)) {
    const grouped = new Map<string, unknown[]>();
    for (const entry of files as unknown[])
      if (isUploadedFile(entry))
        grouped.set(entry.fieldname, [
          ...(grouped.get(entry.fieldname) ?? []),
          entry,
        ]);
    for (const [field, list] of grouped) put(field, list);
  } else if (typeof files === 'object' && files !== null)
    for (const [field, list] of Object.entries(files))
      if (Array.isArray(list)) put(field, list);
  if (isUploadedFile(file)) put(file.fieldname, file);
  return found ? result : undefined;
}

/**
 * @internal Default input: query for bodiless methods, body otherwise, with
 * uploaded files merged in by field name (a file wins over a same-named field).
 */
export function defaultPrecognitionInput(request: object): unknown {
  const { method, query, body } = request as {
    method?: unknown;
    query?: unknown;
    body?: unknown;
  };
  const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
  if (['GET', 'HEAD', 'DELETE'].includes(verb)) return query ?? {};
  const files = uploadedFiles(request);
  if (!files) return body ?? {};
  const fields =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body
      : {};
  return { ...fields, ...files };
}

/** Raw Node response behind an Express response or a Fastify reply. */
interface RawResponse {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
  readonly headersSent?: boolean;
}

function rawResponse(response: object): RawResponse | undefined {
  const raw: unknown = (response as { raw?: unknown }).raw ?? response;
  return typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Partial<RawResponse>).setHeader === 'function' &&
    typeof (raw as Partial<RawResponse>).getHeader === 'function' &&
    typeof (raw as Partial<RawResponse>).removeHeader === 'function'
    ? (raw as RawResponse)
    : undefined;
}

function varyTokens(value: unknown): string[] {
  const text = Array.isArray(value)
    ? value.join(',')
    : typeof value === 'string'
      ? value
      : '';
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @internal Labels a response as a Precognition reply (`Precognition: true`,
 * `Vary: Precognition` merged) directly on the raw Node response, so the
 * headers survive replies produced by middleware, guards and exception
 * filters as well as the adapter's own.
 */
export function markPrecognitionResponse(response: object): void {
  const raw = rawResponse(response);
  if (!raw || raw.headersSent === true) return;
  raw.setHeader(PrecognitionHeader.precognition, 'true');
  const vary = varyTokens(raw.getHeader('Vary'));
  if (!vary.some((token) => token.toLowerCase() === 'precognition'))
    raw.setHeader(
      'Vary',
      [...vary, PrecognitionHeader.precognition].join(', '),
    );
}

/** @internal Removes the labels again when the route is not precognitive. */
export function unmarkPrecognitionResponse(response: object): void {
  const raw = rawResponse(response);
  if (!raw || raw.headersSent === true) return;
  raw.removeHeader(PrecognitionHeader.precognition);
  const vary = varyTokens(raw.getHeader('Vary')).filter(
    (token) => token.toLowerCase() !== 'precognition',
  );
  if (vary.length === 0) raw.removeHeader('Vary');
  else raw.setHeader('Vary', vary.join(', '));
}
