import type { LoggerService } from '@nestjs/common';

/** Replacement for redacted values; stable so tests and log queries can match it. */
export const REDACTED = '[REDACTED]';

/**
 * Key fragments treated as sensitive by default (case-insensitive substring
 * match on the key, ignoring `-`/`_`): credentials, session and CSRF material,
 * Live snapshot tokens and signatures.
 */
export const DEFAULT_SENSITIVE_KEYS = Object.freeze([
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'csrf',
  'session',
  'apikey',
  'privatekey',
  'credential',
  'snapshot',
  'signature',
]);

export interface RedactionOptions {
  /** Extra key fragments (merged with the defaults). */
  readonly keys?: readonly string[];
  /** Maximum nesting depth before values are replaced by `[Truncated]` (default 8). */
  readonly maxDepth?: number;
  /** Maximum array items and object keys kept per level (default 100). */
  readonly maxEntries?: number;
}

const bearer = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}
function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError('Invalid redaction limit');
  return value;
}

/** Compiled redaction policy: `value(v)` deep-redacts, `text(s)` scrubs credentials in strings. */
export interface Redactor {
  value(value: unknown): unknown;
  text(value: string): string;
  sensitive(key: string): boolean;
}

/**
 * Build a redactor. Values under sensitive keys become `[REDACTED]`;
 * `Bearer`/`Basic` credentials inside strings are scrubbed; cycles become
 * `[Circular]`; depth and size are bounded; `Error`s keep only name and
 * message (redacted), never stacks or attached properties; functions and
 * symbols are dropped. Getters are never evaluated.
 */
export function createRedactor(options: RedactionOptions = {}): Redactor {
  const fragments = [
    ...DEFAULT_SENSITIVE_KEYS,
    ...(options.keys ?? []).map((key) => {
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(key))
        throw new TypeError('Invalid redaction key');
      return normalize(key);
    }),
  ];
  const maxDepth = boundedInteger(options.maxDepth, 8, 64);
  const maxEntries = boundedInteger(options.maxEntries, 100, 10_000);
  const sensitive = (key: string) => {
    const normalized = normalize(key);
    return fragments.some((fragment) => normalized.includes(fragment));
  };
  const text = (value: string) => value.replace(bearer, `$1 ${REDACTED}`);
  const walk = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (typeof value === 'string') return text(value);
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated]';
    if (value instanceof Error)
      return { name: value.name, message: text(value.message) };
    if (value instanceof Date) return value.toISOString();
    seen.add(value);
    try {
      if (Array.isArray(value))
        return value
          .slice(0, maxEntries)
          .map((item: unknown) => walk(item, depth + 1, seen));
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value).slice(0, maxEntries)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) continue;
        result[key] = sensitive(key)
          ? REDACTED
          : walk(descriptor.value, depth + 1, seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  };
  return Object.freeze({
    value: (value: unknown) => walk(value, 0, new Set()),
    text,
    sensitive,
  });
}

/** One-off deep redaction with the default policy (or `options`). */
export function redact(value: unknown, options?: RedactionOptions): unknown {
  return createRedactor(options).value(value);
}

/**
 * Wrap a Nest `LoggerService` so every message and structured parameter is
 * redacted before it reaches the underlying logger. String messages are
 * scrubbed of credentials; objects are deep-redacted by key.
 */
export function createRedactingLogger(
  base: LoggerService,
  options?: RedactionOptions,
): LoggerService {
  const redactor = createRedactor(options);
  const clean = (args: unknown[]) => args.map((arg) => redactor.value(arg));
  const forward =
    (level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal') =>
    (message: unknown, ...optional: unknown[]): void => {
      const method = base[level];
      if (typeof method !== 'function') return;
      Reflect.apply(method, base, [
        redactor.value(message),
        ...clean(optional),
      ]);
    };
  return {
    log: forward('log'),
    error: forward('error'),
    warn: forward('warn'),
    debug: forward('debug'),
    verbose: forward('verbose'),
    fatal: forward('fatal'),
  };
}
