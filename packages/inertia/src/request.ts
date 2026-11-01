import { FORBIDDEN_KEYS, InertiaHeader } from './constants.js';
import { InertiaRequestError } from './errors.js';
import { hasControlCharacter } from './text.js';

/** Upper bounds applied to every `X-Inertia-*` request header. */
export interface InertiaHeaderLimits {
  /** Maximum characters in one header value. Default 4096. */
  readonly headerLength: number;
  /** Maximum entries in one comma-separated list. Default 128. */
  readonly listEntries: number;
  /** Maximum characters in one list entry, component or bag name. Default 256. */
  readonly entryLength: number;
}

export const defaultHeaderLimits: InertiaHeaderLimits = Object.freeze({
  headerLength: 4096,
  listEntries: 128,
  entryLength: 256,
});

/** Parsed, validated Inertia request metadata. */
export interface InertiaRequestInfo {
  readonly inertia: boolean;
  readonly method: string;
  readonly version: string | undefined;
  readonly partialComponent: string | undefined;
  readonly only: readonly string[] | undefined;
  readonly except: readonly string[] | undefined;
  readonly reset: readonly string[];
  readonly exceptOnce: readonly string[];
  readonly errorBag: string | undefined;
  readonly mergeIntent: 'append' | 'prepend';
  readonly prefetch: boolean;
}

type HeaderBag = Readonly<Record<string, unknown>>;

function headerBag(request: object): HeaderBag {
  const headers = (request as { headers?: unknown }).headers;
  return typeof headers === 'object' && headers !== null
    ? (headers as HeaderBag)
    : {};
}

/** Reads one header. Repeated (array) or non-string values are malformed. */
function read(
  headers: HeaderBag,
  name: string,
  limits: InertiaHeaderLimits,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InertiaRequestError(name);
  if (value.length > limits.headerLength || hasControlCharacter(value))
    throw new InertiaRequestError(name);
  return value;
}

function name(
  headers: HeaderBag,
  header: string,
  limits: InertiaHeaderLimits,
): string | undefined {
  const value = read(headers, header, limits);
  if (value === undefined || value === '') return undefined;
  if (value.length > limits.entryLength) throw new InertiaRequestError(header);
  return value;
}

/**
 * Comma-separated prop paths. Upstream (`PropsResolver::parseHeader`) splits on
 * `,` and drops empty entries; an empty list means "header absent". Entries are
 * dot paths whose segments must be non-empty and never prototype keys.
 */
function list(
  headers: HeaderBag,
  header: string,
  limits: InertiaHeaderLimits,
): string[] | undefined {
  const value = read(headers, header, limits);
  if (value === undefined) return undefined;
  const entries = value.split(',').filter((entry) => entry !== '');
  if (entries.length === 0) return undefined;
  if (entries.length > limits.listEntries)
    throw new InertiaRequestError(header);
  for (const entry of entries) {
    if (entry.length > limits.entryLength)
      throw new InertiaRequestError(header);
    for (const segment of entry.split('.'))
      if (segment === '' || FORBIDDEN_KEYS.has(segment))
        throw new InertiaRequestError(header);
  }
  return entries;
}

export function requestMethod(request: object): string {
  const method = (request as { method?: unknown }).method;
  return typeof method === 'string' ? method.toUpperCase() : 'GET';
}

/** True only for `X-Inertia: true`, the value the official client sends. */
export function isInertiaRequest(request: object): boolean {
  const value = headerBag(request)['x-inertia'];
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

/**
 * Parses and validates the Inertia request headers. Partial-reload, reset and
 * once-exclusion headers are honoured only on Inertia requests, so a full page
 * load always receives the complete eligible prop set.
 */
export function parseInertiaRequest(
  request: object,
  limits: InertiaHeaderLimits = defaultHeaderLimits,
): InertiaRequestInfo {
  const headers = headerBag(request);
  const inertia = isInertiaRequest(request);
  const method = requestMethod(request);
  // Purpose is a general (non-Inertia) header: never reject a request over it.
  const prefetch = [InertiaHeader.purpose, InertiaHeader.secPurpose].some(
    (header) => {
      const value = headers[header.toLowerCase()];
      return (
        typeof value === 'string' &&
        value.length <= 256 &&
        /(?:^|[\s,;])prefetch(?:$|[\s,;])/i.test(value)
      );
    },
  );
  if (!inertia)
    return {
      inertia,
      method,
      version: undefined,
      partialComponent: undefined,
      only: undefined,
      except: undefined,
      reset: [],
      exceptOnce: [],
      errorBag: undefined,
      mergeIntent: 'append',
      prefetch,
    };
  const version = read(headers, InertiaHeader.version, limits);
  if (version !== undefined && version.length > limits.entryLength * 2)
    throw new InertiaRequestError(InertiaHeader.version);
  const intent = read(headers, InertiaHeader.infiniteScrollMergeIntent, limits);
  if (intent !== undefined && intent !== 'append' && intent !== 'prepend')
    throw new InertiaRequestError(InertiaHeader.infiniteScrollMergeIntent);
  const errorBag = name(headers, InertiaHeader.errorBag, limits);
  if (
    errorBag !== undefined &&
    (FORBIDDEN_KEYS.has(errorBag) || errorBag.includes('.'))
  )
    throw new InertiaRequestError(InertiaHeader.errorBag);
  return {
    inertia,
    method,
    version,
    partialComponent: name(headers, InertiaHeader.partialComponent, limits),
    only: list(headers, InertiaHeader.partialData, limits),
    except: list(headers, InertiaHeader.partialExcept, limits),
    reset: list(headers, InertiaHeader.reset, limits) ?? [],
    exceptOnce: list(headers, InertiaHeader.exceptOnceProps, limits) ?? [],
    errorBag,
    mergeIntent: intent === 'prepend' ? 'prepend' : 'append',
    prefetch,
  };
}

/** Reads a single plain header value without Inertia validation. */
export function plainHeader(
  request: object,
  header: string,
): string | undefined {
  const value = headerBag(request)[header.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}
