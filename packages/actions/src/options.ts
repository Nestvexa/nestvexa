import type { ActionIdempotencyStore } from './idempotency.js';
import type { ActionJobQueue, ActionJobsOptions } from './jobs.js';
import type { ActionRateLimit } from './limits.js';
import type { ActionDescriptor, ActionGroupDefinition } from './metadata.js';
import type { ActionIdentity } from './state.js';
import type { ActionErrorCode } from './shared/protocol.js';
import { isFeatureRegistry, isKernelIdentitySource } from './kernel.js';
import type {
  ActionFeatureRegistry,
  ActionKernelIdentitySource,
} from './kernel.js';
import { isActionPolicyRegistry } from './policies.js';
import type { ActionPolicyRegistry } from './policies.js';

/**
 * Span attributes are small primitives chosen by the runtime (group, action,
 * version, request id, status, code). Inputs, outputs and identities never
 * appear. Structurally identical to `@nestvexa/observability`'s
 * `SpanAttributes`, so `MemoryInstrumentation`,
 * `openTelemetryInstrumentation(tracer)` and `combineInstrumentation(...)`
 * can be passed as `instrumentation` without a package dependency.
 */
export type ActionSpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface ActionSpan {
  end(outcome: 'ok' | 'error', attributes?: ActionSpanAttributes): void;
}
export interface ActionsInstrumentation {
  start(name: string, attributes: ActionSpanAttributes): ActionSpan;
}
/** Structurally compatible with `@nestvexa/observability`'s `StructuredLogger`. */
export interface ActionsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
/**
 * One structured record per call, logged as `nestvexa.action` (info for
 * 2xx, warn for 4xx, error for 5xx). Redaction is by construction: the
 * record has no input, output, identity, header or error message fields.
 */
export interface ActionCallLog {
  readonly requestId: string;
  readonly group: string;
  readonly action: string;
  readonly version: number | null;
  readonly status: number;
  readonly code: ActionErrorCode | 'OK' | 'ACCEPTED';
  readonly reason?: string;
  readonly durationMs: number;
  readonly replayed: boolean;
  readonly jobId?: string;
}

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
  /** Tracing: one `nestvexa.action` span per call, ended with the HTTP status. */
  readonly instrumentation?: ActionsInstrumentation;
  /** Structured per-call logs (`ActionCallLog` fields only; inputs are never logged). */
  readonly logger?: ActionsLogger;
  /** Queue for `job: true` actions (202 job tickets, status polling, cancellation). */
  readonly jobs?: ActionJobsOptions;
  /**
   * Request correlation (structural; for example `RequestContextFactory`
   * from @nestvexa/core). The envelope `requestId`, the
   * `x-nestvexa-request-id` header, call logs and spans then use the host
   * correlation ID instead of a random one. Malformed IDs are ignored.
   */
  readonly requestContext?: { correlationId(request: object): string };
  /**
   * Kernel security policy registry (structural; for example
   * `SecurityPolicyRegistry` from @nestvexa/core). Actions register their
   * origin, CSRF (when required) and action-authorization policies under
   * `policyOwner` at startup and ask the registry for every origin, CSRF
   * and authorization decision, so the registry is the single source of
   * truth. Without it the same policies are enforced directly.
   */
  readonly policies?: ActionPolicyRegistry;
  /** Owner name for `policies` (default `actions`); a duplicate owner fails startup. */
  readonly policyOwner?: string;
  /**
   * Opt-in kernel identity (structural; for example `RequestContextFactory`
   * from @nestvexa/core). Actions still call `resolveIdentity` for the
   * subject and CSRF token, then attach the kernel `principal` and use the
   * kernel `tenant` (rate limits, job owners, serial keys). A host subject
   * that differs from the kernel principal id, or a host tenant that differs
   * from the kernel tenant, is `401 UNAUTHENTICATED` (`IDENTITY_MISMATCH`).
   */
  readonly kernelIdentity?: ActionKernelIdentitySource;
  /**
   * Kernel feature registry (structural; for example `NestvexaRegistry`
   * from @nestvexa/core): actions register their safe actions and
   * capabilities under `policyOwner` (default `actions`).
   */
  readonly featureRegistry?: ActionFeatureRegistry;
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
  readonly instrumentation: ActionsInstrumentation | undefined;
  readonly logger: ActionsLogger | undefined;
  readonly jobQueue: ActionJobQueue | undefined;
  readonly jobChannel: ((id: string) => string) | undefined;
  readonly jobOwner: ActionJobsOptions['owner'];
  readonly jobPollAfterMs: number;
  readonly requestContext: ActionsHostOptions['requestContext'];
  readonly policies: ActionPolicyRegistry | undefined;
  readonly policyOwner: string;
  readonly kernelIdentity: ActionKernelIdentitySource | undefined;
  readonly featureRegistry: ActionFeatureRegistry | undefined;
}

export const HOST_KEYS: ReadonlySet<string> = new Set([
  'origin',
  'resolveIdentity',
  'authorize',
  'csrf',
  'rateLimit',
  'limits',
  'idempotency',
  'exposeErrorDetails',
  'onError',
  'instrumentation',
  'logger',
  'jobs',
  'requestContext',
  'policies',
  'policyOwner',
  'kernelIdentity',
  'featureRegistry',
]);

function hasMethods(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

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
  const instrumentation = options['instrumentation'];
  if (instrumentation !== undefined && !hasMethods(instrumentation, ['start']))
    throw new Error(
      'Actions instrumentation must implement start(name, attributes)',
    );
  const logger = options['logger'];
  if (logger !== undefined && !hasMethods(logger, ['info', 'warn', 'error']))
    throw new Error('Actions logger must implement info, warn and error');
  const jobs = dataRecord(options['jobs'], 'jobs');
  for (const key of Object.keys(jobs))
    if (!['queue', 'channel', 'pollAfterMs', 'owner'].includes(key))
      throw new Error(`Unknown actions jobs option ${key}`);
  const queue = jobs['queue'];
  if (options['jobs'] !== undefined && !hasMethods(queue, ['enqueue', 'get']))
    throw new Error('Actions jobs.queue must implement enqueue and get');
  if (
    queue !== undefined &&
    Reflect.get(queue as object, 'cancel') !== undefined &&
    typeof Reflect.get(queue as object, 'cancel') !== 'function'
  )
    throw new Error('Actions jobs.queue.cancel must be a function');
  const channel = jobs['channel'];
  if (channel !== undefined && typeof channel !== 'function')
    throw new Error('Actions jobs.channel must be a function');
  const owner = jobs['owner'];
  if (owner !== undefined && typeof owner !== 'function')
    throw new Error('Actions jobs.owner must be a function');
  const requestContext = options['requestContext'];
  if (
    requestContext !== undefined &&
    !hasMethods(requestContext, ['correlationId'])
  )
    throw new Error(
      'Actions requestContext must implement correlationId(request)',
    );
  const policies = options['policies'];
  if (policies !== undefined && !isActionPolicyRegistry(policies))
    throw new Error(
      'Actions policies must implement register, originAllowed, verifyCsrf and authorize',
    );
  const policyOwner = options['policyOwner'];
  if (
    policyOwner !== undefined &&
    (policies === undefined ||
      typeof policyOwner !== 'string' ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(policyOwner))
  )
    throw new Error(
      'Actions policyOwner must be a lowercase name (a-z0-9._-) used with policies',
    );
  const kernelIdentity = options['kernelIdentity'];
  if (kernelIdentity !== undefined && !isKernelIdentitySource(kernelIdentity))
    throw new Error('Actions kernelIdentity must implement identity(request)');
  const featureRegistry = options['featureRegistry'];
  if (featureRegistry !== undefined && !isFeatureRegistry(featureRegistry))
    throw new Error(
      'Actions featureRegistry must implement registerFeature(feature)',
    );
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
    instrumentation: instrumentation as ActionsInstrumentation | undefined,
    logger: logger as ActionsLogger | undefined,
    jobQueue: queue as ActionJobQueue | undefined,
    jobChannel: channel as ((id: string) => string) | undefined,
    jobOwner: owner as ActionJobsOptions['owner'],
    jobPollAfterMs: integer(
      jobs['pollAfterMs'],
      'jobs.pollAfterMs',
      1_000,
      100,
      60_000,
    ),
    requestContext: requestContext as ActionsHostOptions['requestContext'],
    policies,
    policyOwner: typeof policyOwner === 'string' ? policyOwner : 'actions',
    kernelIdentity,
    featureRegistry,
  });
}
