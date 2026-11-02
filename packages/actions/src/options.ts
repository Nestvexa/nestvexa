import type { ActionIdempotencyStore } from './idempotency.js';
import type { ActionRateLimit } from './limits.js';
import type { ActionDescriptor, ActionGroupDefinition } from './metadata.js';
import type { ActionIdentity } from './state.js';
import type { ActionErrorCode } from './shared/protocol.js';

export interface ActionLimits {
  /** Maximum JSON request body bytes (declared and re-serialized), default 65536. */
  readonly maxBodyBytes?: number;
  /** Maximum request JSON nesting depth, default 32. */
  readonly maxDepth?: number;
  /** Maximum request JSON values, default 10000. */
  readonly maxNodes?: number;
  /** Maximum serialized response data bytes, default 1048576. */
  readonly maxOutputBytes?: number;
  /** Default action deadline in milliseconds, default 30000. */
  readonly timeoutMs?: number;
  /** Maximum queued calls per serial key before RATE_LIMITED, default 16. */
  readonly maxQueuedPerKey?: number;
}

export interface ActionIdempotencyOptions {
  readonly store?: ActionIdempotencyStore;
  /** Replay retention in milliseconds, default 86400000 (24 hours). */
  readonly ttlMs?: number;
}

export interface ActionErrorEvent {
  readonly requestId: string;
  readonly action: ActionDescriptor | undefined;
  readonly code: ActionErrorCode;
  readonly status: number;
  /** The original server-side error; may contain sensitive data, never sent to clients. */
  readonly error: unknown;
}

export interface ActionCsrfOptions {
  /** Default true. Disable only for non-cookie (bearer/mTLS) authentication. */
  readonly required?: boolean;
  /** Request header carrying the token, default `x-nestvexa-csrf`. */
  readonly header?: string;
}

/** Host security policy; supplied directly or by `registerAsync`'s factory. */
export interface ActionsHostOptions {
  /** Exact allowed browser origin(s), e.g. `https://shop.example`. Requests must send a matching Origin. */
  readonly origin: string | readonly string[];
  /** Resolve the principal from verified server state. Return null for anonymous (UNAUTHENTICATED). */
  readonly resolveIdentity: (
    request: object,
  ) => ActionIdentity | null | Promise<ActionIdentity | null>;
  /** Coarse host authorization evaluated for every call before Nest guards on the group. */
  readonly authorize: (
    identity: ActionIdentity,
    action: ActionDescriptor,
    request: object,
  ) => boolean | Promise<boolean>;
  readonly csrf?: ActionCsrfOptions;
  /** Rate limit hook; default 120 requests/minute per tenant+subject. `false` disables. */
  readonly rateLimit?: ActionRateLimit | false;
  readonly limits?: ActionLimits;
  readonly idempotency?: ActionIdempotencyOptions;
  /** Include server error messages as `error.detail` (development only). Default false. */
  readonly exposeErrorDetails?: boolean;
  /** Observe failures (structured logging/tracing). Default logs 5xx through Nest's Logger. */
  readonly onError?: (event: ActionErrorEvent) => void;
}

export type ActionsErrorEnvelopeMode = 'actions' | 'host';

export interface NormalizedActionsOptions {
  readonly prefix: string;
  readonly groups: readonly ActionGroupDefinition[];
  readonly errorEnvelope: ActionsErrorEnvelopeMode;
  readonly origins: ReadonlySet<string>;
  readonly resolveIdentity: ActionsHostOptions['resolveIdentity'];
  readonly authorize: ActionsHostOptions['authorize'];
  readonly csrfRequired: boolean;
  readonly csrfHeader: string;
  readonly rateLimit: ActionRateLimit | false | undefined;
  readonly maxBodyBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly maxQueuedPerKey: number;
  readonly idempotencyStore: ActionIdempotencyStore | undefined;
  readonly idempotencyTtlMs: number;
  readonly exposeErrorDetails: boolean;
  readonly onError: ActionsHostOptions['onError'];
}

const HOST_KEYS: ReadonlySet<string> = new Set([
  'origin',
  'resolveIdentity',
  'authorize',
  'csrf',
  'rateLimit',
  'limits',
  'idempotency',
  'exposeErrorDetails',
  'onError',
]);

function integer(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Actions option ${name} must be an integer ${min}-${max}`);
  return value;
}

function dataRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Actions option ${name} must be an object`);
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new Error(`Actions option ${name} must use own data properties`);
    copy[key] = descriptor.value;
  }
  return copy;
}

function origins(value: unknown): ReadonlySet<string> {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(
      'Actions origin must be an exact HTTP(S) origin or a non-empty list',
    );
  const result = new Set<string>();
  for (const entry of list) {
    let parsed: URL;
    try {
      parsed = new URL(String(entry));
    } catch {
      throw new Error(
        `Actions origin ${String(entry)} is not a valid URL origin`,
      );
    }
    if (
      typeof entry !== 'string' ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== entry
    )
      throw new Error(
        `Actions origin ${String(entry)} must be an exact origin such as https://app.example (no path or trailing slash)`,
      );
    result.add(entry);
  }
  return result;
}

/** Validates host policy; rejects unknown keys, accessors and inherited values. */
export function normalizeHostOptions(
  input: unknown,
): Omit<NormalizedActionsOptions, 'prefix' | 'groups' | 'errorEnvelope'> {
  const options = dataRecord(input, 'host policy');
  for (const key of Object.keys(options))
    if (!HOST_KEYS.has(key))
      throw new Error(`Unknown actions host option ${key}`);
  if (
    typeof options['resolveIdentity'] !== 'function' ||
    typeof options['authorize'] !== 'function'
  )
    throw new Error(
      'ActionsModule requires resolveIdentity and authorize host policies; actions are authorization-first',
    );
  const csrf = dataRecord(options['csrf'], 'csrf');
  for (const key of Object.keys(csrf))
    if (key !== 'required' && key !== 'header')
      throw new Error(`Unknown actions csrf option ${key}`);
  if (csrf['required'] !== undefined && typeof csrf['required'] !== 'boolean')
    throw new Error('Actions csrf.required must be a boolean');
  const header = csrf['header'] ?? 'x-nestvexa-csrf';
  if (typeof header !== 'string' || !/^x-[a-z0-9-]{1,62}$/.test(header))
    throw new Error('Actions csrf.header must be a lowercase x- header name');
  const rateLimit = options['rateLimit'];
  if (
    rateLimit !== undefined &&
    rateLimit !== false &&
    typeof rateLimit !== 'function'
  )
    throw new Error('Actions rateLimit must be a function or false');
  const limits = dataRecord(options['limits'], 'limits');
  const limitKeys = new Set([
    'maxBodyBytes',
    'maxDepth',
    'maxNodes',
    'maxOutputBytes',
    'timeoutMs',
    'maxQueuedPerKey',
  ]);
  for (const key of Object.keys(limits))
    if (!limitKeys.has(key)) throw new Error(`Unknown actions limit ${key}`);
  const idempotency = dataRecord(options['idempotency'], 'idempotency');
  for (const key of Object.keys(idempotency))
    if (key !== 'store' && key !== 'ttlMs')
      throw new Error(`Unknown actions idempotency option ${key}`);
  const store = idempotency['store'];
  if (
    store !== undefined &&
    (typeof store !== 'object' ||
      store === null ||
      typeof Reflect.get(store, 'begin') !== 'function' ||
      typeof Reflect.get(store, 'complete') !== 'function' ||
      typeof Reflect.get(store, 'abandon') !== 'function')
  )
    throw new Error(
      'Actions idempotency.store must implement begin, complete and abandon',
    );
  if (
    options['exposeErrorDetails'] !== undefined &&
    typeof options['exposeErrorDetails'] !== 'boolean'
  )
    throw new Error('Actions exposeErrorDetails must be a boolean');
  if (
    options['onError'] !== undefined &&
    typeof options['onError'] !== 'function'
  )
    throw new Error('Actions onError must be a function');
  return Object.freeze({
    origins: origins(options['origin']),
    resolveIdentity: options[
      'resolveIdentity'
    ] as ActionsHostOptions['resolveIdentity'],
    authorize: options['authorize'] as ActionsHostOptions['authorize'],
    csrfRequired: csrf['required'] !== false,
    csrfHeader: header,
    rateLimit: rateLimit as ActionRateLimit | false | undefined,
    maxBodyBytes: integer(
      limits['maxBodyBytes'],
      'limits.maxBodyBytes',
      65_536,
      2,
      16_777_216,
    ),
    maxDepth: integer(limits['maxDepth'], 'limits.maxDepth', 32, 2, 256),
    maxNodes: integer(
      limits['maxNodes'],
      'limits.maxNodes',
      10_000,
      1,
      1_000_000,
    ),
    maxOutputBytes: integer(
      limits['maxOutputBytes'],
      'limits.maxOutputBytes',
      1_048_576,
      2,
      67_108_864,
    ),
    timeoutMs: integer(
      limits['timeoutMs'],
      'limits.timeoutMs',
      30_000,
      1,
      600_000,
    ),
    maxQueuedPerKey: integer(
      limits['maxQueuedPerKey'],
      'limits.maxQueuedPerKey',
      16,
      0,
      10_000,
    ),
    idempotencyStore: store as ActionIdempotencyStore | undefined,
    idempotencyTtlMs: integer(
      idempotency['ttlMs'],
      'idempotency.ttlMs',
      86_400_000,
      1_000,
      604_800_000,
    ),
    exposeErrorDetails: options['exposeErrorDetails'] === true,
    onError: options['onError'] as ActionsHostOptions['onError'],
  });
}
