/**
 * Validation errors keyed by stable dotted paths such as `email` or
 * `items.0.name`. Form-level errors use {@link FORM_ERROR}. Values are plain JSON
 * so a bag can be stored in Live state or a host session.
 */
export type FormErrors = Readonly<Record<string, readonly string[]>>;

/** Key for errors that belong to the whole form rather than one field. */
export const FORM_ERROR = '_form';

/** One path segment: an object key or a non-negative array index. */
export type PathSegment = string | number;

/** Machine-readable reasons {@link hardenInput} refuses a value. */
export type FormInputErrorCode =
  | 'FORBIDDEN_KEY'
  | 'INVALID_KEY'
  | 'DEPTH'
  | 'KEYS'
  | 'NODES'
  | 'STRING_LENGTH'
  | 'ARRAY_LENGTH'
  | 'SPARSE_ARRAY'
  | 'TYPE'
  | 'CONFLICT';

/**
 * Input was rejected before any schema ran: an attack shape (prototype keys,
 * getters, unexpected types) or a resource bound. Hosts usually answer 400.
 * The message never echoes submitted values.
 */
export class FormInputError extends Error {
  override readonly name = 'FormInputError';
  constructor(
    readonly code: FormInputErrorCode,
    /** Dotted path of the offending node; `''` is the root. */
    readonly path: string,
  ) {
    super(`Form input rejected (${code}${path ? ` at ${path}` : ''})`);
  }
}

/** Keys never accepted anywhere in submitted data or paths. */
export const forbiddenKeys: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const keyPattern = /^[A-Za-z0-9_-]{1,128}$/;
const maxSegments = 16;

/** True when `key` is an acceptable object key in form data and error paths. */
export function safeKey(key: string): boolean {
  return keyPattern.test(key) && !forbiddenKeys.has(key);
}

/**
 * Join segments into a stable dotted path. A segment that is not a safe key or
 * a non-negative safe integer ends the path, so the error attaches to the
 * nearest representable ancestor; it is never echoed verbatim.
 */
export function formatPath(segments: readonly PropertyKey[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (parts.length >= maxSegments) break;
    if (typeof segment === 'number') {
      if (!Number.isSafeInteger(segment) || segment < 0) break;
      parts.push(String(segment));
    } else if (typeof segment === 'string' && safeKey(segment))
      parts.push(segment);
    else break;
  }
  return parts.join('.');
}

/** Split a dotted path into validated segments; numeric segments become numbers. */
export function parsePath(path: string): PathSegment[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512)
    throw new FormInputError('INVALID_KEY', '');
  const parts = path.split('.');
  if (parts.length > maxSegments) throw new FormInputError('DEPTH', '');
  return parts.map((part) => {
    if (!safeKey(part))
      throw new FormInputError(
        forbiddenKeys.has(part) ? 'FORBIDDEN_KEY' : 'INVALID_KEY',
        '',
      );
    return /^(?:0|[1-9][0-9]{0,8})$/.test(part) ? Number(part) : part;
  });
}

const maxPaths = 100;
const maxMessages = 5;
const maxMessageLength = 500;

/**
 * Normalize untrusted or adapter-produced error data into a bounded
 * {@link FormErrors}: at most 100 paths, 5 messages per path and 500 characters
 * per message. Unsafe paths fall back to {@link FORM_ERROR}.
 */
export function normalizeErrors(value: unknown): FormErrors {
  const result: Record<string, string[]> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return Object.freeze(result);
  let count = 0;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const raw: unknown = descriptor.value;
    const list = (Array.isArray(raw) ? raw : [raw])
      .filter((item): item is string => typeof item === 'string' && !!item)
      .map((item) => item.slice(0, maxMessageLength));
    if (!list.length) continue;
    const path = key === FORM_ERROR ? FORM_ERROR : safePath(key);
    const existing = result[path];
    if (existing) {
      for (const message of list)
        if (existing.length < maxMessages && !existing.includes(message))
          existing.push(message);
      continue;
    }
    if (count >= maxPaths) continue;
    count++;
    result[path] = [...new Set(list)].slice(0, maxMessages);
  }
  return freezeErrors(result);
}
function safePath(key: string): string {
  try {
    return formatPath(parsePath(key)) || FORM_ERROR;
  } catch {
    return FORM_ERROR;
  }
}
function freezeErrors(errors: Record<string, string[]>): FormErrors {
  for (const key of Object.keys(errors)) {
    const list = errors[key];
    if (list) Object.freeze(list);
  }
  return Object.freeze(errors);
}

/** Collect issues into a bounded error bag (first message per path first). */
export function errorsFromIssues(
  issues: readonly { readonly path: string; readonly message: string }[],
): FormErrors {
  const bag: Record<string, string[]> = {};
  for (const issue of issues) {
    const path = issue.path || FORM_ERROR;
    (bag[path] ??= []).push(issue.message);
  }
  return normalizeErrors(bag);
}

/** True when `path` is `field` itself or one of its descendants. */
export function pathWithin(path: string, field: string): boolean {
  return path === field || path.startsWith(field + '.');
}

/** True when the bag holds at least one message. */
export function hasErrors(errors: FormErrors | undefined): boolean {
  return !!errors && Object.values(errors).some((list) => list.length > 0);
}

/** Entries of `errors` that belong to the given top-level fields (or their descendants). */
export function pickErrors(
  errors: FormErrors,
  fields: readonly string[],
): FormErrors {
  const result: Record<string, string[]> = {};
  for (const [path, list] of Object.entries(errors))
    if (fields.some((field) => pathWithin(path, field)))
      result[path] = [...list];
  return freezeErrors(result);
}

/**
 * Replace the entries for `fields` in `current` with those from `next`, keeping
 * every other path. Used for per-field (live) validation.
 */
export function replaceErrors(
  current: FormErrors,
  next: FormErrors,
  fields: readonly string[],
): FormErrors {
  const result: Record<string, string[]> = {};
  for (const [path, list] of Object.entries(normalizeErrors(current)))
    if (!fields.some((field) => pathWithin(path, field)))
      result[path] = [...list];
  for (const [path, list] of Object.entries(next))
    if (fields.some((field) => pathWithin(path, field)))
      result[path] = [...list];
  return normalizeErrors(result);
}

/** First message for exactly `path`, or `''`. */
export function firstError(errors: FormErrors, path: string): string {
  return Object.hasOwn(errors, path) ? (errors[path]?.[0] ?? '') : '';
}
