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

export interface PrecognitiveOptions {
  /**
   * Reads the data to validate. Default: the query for GET/HEAD/DELETE (where
   * the official client sends it) and the parsed body otherwise.
   */
  readonly input?: (request: object) => unknown;
}

/** @internal Route metadata written by `@Precognitive`. */
export interface PrecognitionMetadata {
  readonly validator: PrecognitionValidator;
  readonly input: ((request: object) => unknown) | undefined;
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

/** @internal Default input: query for bodiless methods, body otherwise. */
export function defaultPrecognitionInput(request: object): unknown {
  const { method, query, body } = request as {
    method?: unknown;
    query?: unknown;
    body?: unknown;
  };
  const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
  const value = ['GET', 'HEAD', 'DELETE'].includes(verb) ? query : body;
  return value ?? {};
}
