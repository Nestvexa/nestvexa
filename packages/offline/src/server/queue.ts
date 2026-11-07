import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Server half of the optional offline action queue (ADR 0026, amendment
 * EXT-014). The server declares which operations a browser may queue while
 * offline, and guards those routes so that a replayed request ID executes at
 * most once per identity.
 */

export type OfflineActionMethod = 'POST' | 'PUT' | 'PATCH';
/** `form`: URL-encoded fields. `action`: the `@nestvexa/actions` `{ "input": … }` JSON envelope. */
export type OfflineActionEncoding = 'form' | 'action';

export interface OfflineActionDefinition {
  /** Stable public id, `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, at most 64 characters. */
  readonly id: string;
  /** Exact same-origin absolute path without query or fragment. */
  readonly path: string;
  /** Default `POST`. `DELETE` and safe methods are never queueable. */
  readonly method?: OfflineActionMethod;
  /** Default `form`. */
  readonly encoding?: OfflineActionEncoding;
  /** Translated, user-facing name shown in the queue list (plain text). */
  readonly label?: string;
  /**
   * Must be literally `true`: the handler is idempotent and its route runs
   * through {@link OfflineReplayGuard.run}, so a replayed request ID executes
   * at most once.
   */
  readonly idempotent: true;
}

export interface OfflineAction {
  readonly id: string;
  readonly path: string;
  readonly method: OfflineActionMethod;
  readonly encoding: OfflineActionEncoding;
  readonly label?: string;
  readonly idempotent: true;
}

export interface OfflineActionAllowlist {
  readonly actions: readonly OfflineAction[];
  get(id: string): OfflineAction | undefined;
  /** The allowlisted action for a request method and path, if any. */
  match(method: string, path: string): OfflineAction | undefined;
  /** JSON for `<meta name="nv-offline-actions" content="…">`; escape it like any attribute value. */
  readonly metaContent: string;
  /** The complete, attribute-escaped `<meta>` element for the document `<head>`. */
  metaTag(): string;
}

/** Request header carrying the queue entry's request ID (shared with `@nestvexa/actions`). */
export const offlineKeyHeader = 'idempotency-key';
/** Request header carrying the identity scope the browser queued the entry under. */
export const offlineScopeHeader = 'x-nestvexa-offline-scope';
/** Response header set to `1` when a stored outcome is returned instead of executing. */
export const offlineReplayedHeader = 'x-nestvexa-offline-replayed';

const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const pathPattern = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const keyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const scopePattern = /^[A-Za-z0-9_-]{16,128}$/;
const methods = new Set<string>(['POST', 'PUT', 'PATCH']);
const definitionKeys = new Set([
  'id',
  'path',
  'method',
  'encoding',
  'label',
  'idempotent',
]);
/**
 * Money movement and deletion are online-only by policy (spec 16.2). This is a
 * speed bump against accidental allowlisting, not a security boundary: the
 * explicit `idempotent: true` declaration and the server guard are.
 */
const neverQueued = new Set([
  'pay',
  'payment',
  'payments',
  'purchase',
  'purchases',
  'checkout',
  'charge',
  'refund',
  'transfer',
  'withdraw',
  'withdrawal',
  'delete',
  'destroy',
  'remove',
  'erase',
]);
const hour = 3_600_000;

function fail(message: string): never {
  throw new TypeError(message);
}
function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
/** Copies own data properties once, rejecting accessors and unknown keys. */
function copyDefinition(value: unknown, index: number): OfflineAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`Offline action #${index} must be a plain object`);
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !definitionKeys.has(key))
      fail(`Offline action #${index} has an unknown option ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      fail(`Offline action #${index} option ${key} must be a data property`);
    fields.set(key, descriptor.value);
  }
  const id = fields.get('id');
  if (typeof id !== 'string' || id.length > 64 || !idPattern.test(id))
    fail(`Offline action #${index} has an invalid id`);
  if (fields.get('idempotent') !== true)
    fail(
      `Offline action ${id} must declare idempotent: true; only idempotent operations may be queued`,
    );
  const path = fields.get('path');
  if (typeof path !== 'string' || path.length > 2048 || !pathPattern.test(path))
    fail(
      `Offline action ${id} path must be a same-origin absolute path without query or fragment`,
    );
  const method = fields.get('method') ?? 'POST';
  if (typeof method !== 'string' || !methods.has(method))
    fail(
      `Offline action ${id} method must be POST, PUT or PATCH; deletes and safe methods are never queued`,
    );
  const encoding = fields.get('encoding') ?? 'form';
  if (encoding !== 'form' && encoding !== 'action')
    fail(`Offline action ${id} encoding must be form or action`);
  const label = fields.get('label');
  if (
    label !== undefined &&
    (typeof label !== 'string' || label.length === 0 || label.length > 200)
  )
    fail(`Offline action ${id} label must be 1–200 characters`);
  if ([...words(id), ...words(path)].some((word) => neverQueued.has(word)))
    fail(
      `Offline action ${id} looks like a payment, purchase or deletion; those are online-only and never queued`,
    );
  return Object.freeze({
    id,
    path,
    method: method as OfflineActionMethod,
    encoding,
    ...(label === undefined ? {} : { label }),
    idempotent: true,
  });
}

/**
 * Declare the operations a browser may queue while offline. Render
 * `metaTag()` (or `metaContent` in an escaped attribute) in the layout's
 * `<head>` on every page that attaches the queue; the browser refuses to queue
 * anything that is not listed here with `idempotent: true`.
 */
export function offlineActionAllowlist(
  definitions: readonly OfflineActionDefinition[],
): OfflineActionAllowlist {
  if (!Array.isArray(definitions))
    fail('Offline actions must be an array of definitions');
  if (definitions.length > 64) fail('At most 64 offline actions are allowed');
  const actions = definitions.map((definition: unknown, index) =>
    copyDefinition(definition, index),
  );
  const byId = new Map<string, OfflineAction>();
  const byRoute = new Map<string, OfflineAction>();
  for (const action of actions) {
    if (byId.has(action.id)) fail(`Duplicate offline action id ${action.id}`);
    const route = `${action.method} ${action.path}`;
    if (byRoute.has(route)) fail(`Duplicate offline action route ${route}`);
    byId.set(action.id, action);
    byRoute.set(route, action);
  }
  const metaContent = JSON.stringify({ v: 1, actions });
  return Object.freeze({
    actions: Object.freeze(actions),
    get: (id: string) => byId.get(id),
    match: (method: string, path: string) =>
      typeof method === 'string' && typeof path === 'string'
        ? byRoute.get(`${method.toUpperCase()} ${path}`)
        : undefined,
    metaContent,
    metaTag: () =>
      `<meta name="nv-offline-actions" content="${escapeAttribute(metaContent)}">`,
  });
}

/** Structural `@nestvexa/actions` client descriptor (from the generated manifest). */
export interface ServerActionDescriptor {
  readonly group: string;
  readonly action: string;
  readonly version: number | null;
  readonly idempotent: boolean;
}

/**
 * Offline definition for an `@nestvexa/actions` server action. Throws unless
 * the action is declared `@ServerAction({ idempotent: true })`; the actions
 * runtime then requires the `Idempotency-Key` header and replays stored
 * results, which is the server-side deduplication for this route.
 */
export function offlineServerAction(
  descriptor: ServerActionDescriptor,
  options: { readonly prefix?: string; readonly label?: string } = {},
): OfflineActionDefinition {
  if (descriptor.idempotent !== true)
    fail(
      `Server action ${String(descriptor.group)}.${String(descriptor.action)} is not idempotent and cannot be queued offline`,
    );
  const prefix = options.prefix ?? '/_nestvexa/actions';
  const version =
    descriptor.version === null ? '' : `/v${String(descriptor.version)}`;
  return {
    id: `${descriptor.group}.${descriptor.action}${descriptor.version === null ? '' : `.v${String(descriptor.version)}`}`,
    path: `${prefix}/${descriptor.group}/${descriptor.action}${version}`,
    method: 'POST',
    encoding: 'action',
    ...(options.label === undefined ? {} : { label: options.label }),
    idempotent: true,
  };
}

/* ------------------------------------------------------------------------ */
/* Replay guard                                                             */
/* ------------------------------------------------------------------------ */

export interface OfflineReplayOutcome<T = unknown> {
  readonly status: number;
  readonly body: T;
}
export type OfflineReplayBegin =
  | { readonly status: 'started' }
  | { readonly status: 'replay'; readonly outcome: OfflineReplayOutcome }
  | { readonly status: 'in-progress' }
  | { readonly status: 'mismatch' }
  | { readonly status: 'full' };

/**
 * Request-ID store. Keys arrive hashed and already bound to the identity
 * scope and action. `begin` must be atomic per key (use SET NX semantics in a
 * shared store); only successful outcomes are completed, failures abandon.
 */
export interface OfflineReplayStore {
  begin(
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): OfflineReplayBegin | Promise<OfflineReplayBegin>;
  complete(key: string, outcome: OfflineReplayOutcome): void | Promise<void>;
  abandon(key: string): void | Promise<void>;
}

interface StoreEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly outcome: OfflineReplayOutcome | undefined;
}

/**
 * Process-local bounded store. Completed entries expire after the TTL and are
 * evicted oldest first when full; in-progress entries are never evicted, so a
 * store full of active work refuses new keys instead of losing a lock.
 */
export class MemoryOfflineReplayStore implements OfflineReplayStore {
  readonly #entries = new Map<string, StoreEntry>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(
    options: { readonly maxEntries?: number; readonly now?: () => number } = {},
  ) {
    const maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      fail('Offline replay store maxEntries must be a positive integer');
    this.#maxEntries = maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  begin(key: string, fingerprint: string, ttlMs: number): OfflineReplayBegin {
    const now = this.#now();
    const existing = this.#entries.get(key);
    if (existing && existing.expiresAt > now) {
      if (existing.fingerprint !== fingerprint) return { status: 'mismatch' };
      return existing.outcome
        ? { status: 'replay', outcome: existing.outcome }
        : { status: 'in-progress' };
    }
    if (existing) this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      for (const [candidate, entry] of this.#entries)
        if (entry.expiresAt <= now) this.#entries.delete(candidate);
      if (this.#entries.size >= this.#maxEntries)
        for (const [candidate, entry] of this.#entries)
          if (entry.outcome) {
            this.#entries.delete(candidate);
            break;
          }
      if (this.#entries.size >= this.#maxEntries) return { status: 'full' };
    }
    this.#entries.set(key, {
      fingerprint,
      expiresAt: now + ttlMs,
      outcome: undefined,
    });
    return { status: 'started' };
  }

  complete(key: string, outcome: OfflineReplayOutcome): void {
    const existing = this.#entries.get(key);
    if (!existing) return;
    // Re-insert so Map order stays oldest-completed-first for eviction.
    this.#entries.delete(key);
    this.#entries.set(key, { ...existing, outcome });
  }

  abandon(key: string): void {
    const existing = this.#entries.get(key);
    if (existing && !existing.outcome) this.#entries.delete(key);
  }
}

export type OfflineReplayErrorCode =
  | 'OFFLINE_NOT_ALLOWED'
  | 'OFFLINE_KEY_REQUIRED'
  | 'OFFLINE_KEY_INVALID'
  | 'OFFLINE_SCOPE_MISMATCH'
  | 'OFFLINE_IN_PROGRESS'
  | 'OFFLINE_KEY_REUSED'
  | 'OFFLINE_CAPACITY';
export interface OfflineReplayError {
  readonly error: { readonly code: OfflineReplayErrorCode };
}
export interface OfflineReplayRejection extends OfflineReplayOutcome<OfflineReplayError> {
  readonly code: OfflineReplayErrorCode;
}
export interface OfflineReplayRequest {
  readonly method: string;
  /** Request path without query string. */
  readonly path: string;
  /** Node `IncomingHttpHeaders` or any record; names are matched case-insensitively. */
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  /** `draftScope(secret, identity)` of the authenticated identity making this request. */
  readonly scope: string;
  /** Parsed body; bound to the request ID so reuse with another body is refused. */
  readonly body?: unknown;
}
export interface OfflineReplayResult<T> {
  readonly status: number;
  readonly body: T | OfflineReplayError;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * `executed`: ran once under a request ID. `replayed`: the stored outcome of
   * an earlier execution. `passthrough`: not an offline replay (for example a
   * plain HTML form post), executed normally. `rejected`: never executed.
   */
  readonly outcome: 'executed' | 'replayed' | 'passthrough' | 'rejected';
}
export interface OfflineReplayGuardOptions {
  readonly allowlist: OfflineActionAllowlist;
  /** Default: a new {@link MemoryOfflineReplayStore}. Share one across replicas. */
  readonly store?: OfflineReplayStore;
  /** Request-ID retention; default and maximum 7 days, minimum 1 second. Keep it above the browser queue TTL. */
  readonly ttlMs?: number;
}
export interface OfflineReplayGuard {
  /** Admission only: the rejection to send, or `null` when the request may proceed to {@link run}. */
  check(request: OfflineReplayRequest): OfflineReplayRejection | null;
  /**
   * Run `execute` at most once per (identity scope, action, request ID). Call
   * it after authentication, CSRF and authorization, as the route handler.
   * Only 2xx outcomes are stored; failures and throws release the request ID
   * so a later retry executes again.
   */
  run<T>(
    request: OfflineReplayRequest,
    execute: () => OfflineReplayOutcome<T> | Promise<OfflineReplayOutcome<T>>,
  ): Promise<OfflineReplayResult<T>>;
}

function header(
  headers: OfflineReplayRequest['headers'],
  name: string,
): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue;
    const value = headers[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      return typeof first === 'string' ? first : undefined;
    }
  }
  return undefined;
}
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}
/** Deterministic JSON with sorted keys, used only for fingerprints. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) fail('Offline replay body is nested too deeply');
  if (Array.isArray(value))
    return `[${value.map((item: unknown) => canonical(item, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`,
      )
      .join(',')}}`;
  }
  return value === undefined ? 'undefined' : (JSON.stringify(value) ?? 'null');
}
function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
function rejection(
  status: number,
  code: OfflineReplayErrorCode,
): OfflineReplayRejection {
  return Object.freeze({ status, code, body: { error: { code } } });
}

/**
 * Server-side enforcement for queued replays. A request carrying the offline
 * scope header to a route that is not allowlisted is refused; on an
 * allowlisted route the request ID executes at most once per identity scope.
 */
export function createOfflineReplayGuard(
  options: OfflineReplayGuardOptions,
): OfflineReplayGuard {
  const allowlist = options.allowlist;
  if (!allowlist || typeof allowlist.match !== 'function')
    fail('Offline replay guard requires an allowlist');
  const ttl = options.ttlMs ?? 7 * 24 * hour;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 7 * 24 * hour)
    fail('Offline replay ttlMs must be an integer from 1000 through 604800000');
  const store = options.store ?? new MemoryOfflineReplayStore();

  function admit(
    request: OfflineReplayRequest,
  ):
    | OfflineReplayRejection
    | { readonly action: OfflineAction; readonly key: string }
    | null {
    if (typeof request.scope !== 'string' || !scopePattern.test(request.scope))
      fail('Offline replay request scope must come from draftScope()');
    const action = allowlist.match(request.method, request.path);
    const scope = header(request.headers, offlineScopeHeader);
    const key = header(request.headers, offlineKeyHeader);
    if (!action)
      // Idempotency-Key alone may belong to another protocol (for example
      // @nestvexa/actions); the offline scope header is ours.
      return scope === undefined ? null : rejection(403, 'OFFLINE_NOT_ALLOWED');
    if (scope === undefined && key === undefined) return null;
    if (key === undefined) return rejection(400, 'OFFLINE_KEY_REQUIRED');
    if (!keyPattern.test(key)) return rejection(400, 'OFFLINE_KEY_INVALID');
    if (scope !== undefined && !sameText(scope, request.scope))
      return rejection(403, 'OFFLINE_SCOPE_MISMATCH');
    return { action, key };
  }

  return Object.freeze({
    check(request: OfflineReplayRequest): OfflineReplayRejection | null {
      const admitted = admit(request);
      return admitted && 'code' in admitted ? admitted : null;
    },
    async run<T>(
      request: OfflineReplayRequest,
      execute: () => OfflineReplayOutcome<T> | Promise<OfflineReplayOutcome<T>>,
    ): Promise<OfflineReplayResult<T>> {
      const admitted = admit(request);
      if (admitted && 'code' in admitted)
        return {
          status: admitted.status,
          body: admitted.body,
          headers: {},
          outcome: 'rejected',
        };
      if (!admitted) {
        const result = await execute();
        return {
          status: result.status,
          body: result.body,
          headers: {},
          outcome: 'passthrough',
        };
      }
      const key = digest(
        `nestvexa-offline-replay:v1\u0000${request.scope}\u0000${admitted.action.id}\u0000${admitted.key}`,
      );
      const fingerprint = digest(
        `${admitted.action.method}\u0000${admitted.action.path}\u0000${canonical(request.body)}`,
      );
      const begun = await store.begin(key, fingerprint, ttl);
      const refused = (
        status: number,
        code: OfflineReplayErrorCode,
      ): OfflineReplayResult<T> => {
        const value = rejection(status, code);
        return {
          status: value.status,
          body: value.body,
          headers: {},
          outcome: 'rejected',
        };
      };
      switch (begun.status) {
        case 'replay':
          return {
            status: begun.outcome.status,
            body: begun.outcome.body as T,
            headers: { [offlineReplayedHeader]: '1' },
            outcome: 'replayed',
          };
        case 'in-progress':
          return refused(409, 'OFFLINE_IN_PROGRESS');
        case 'mismatch':
          return refused(422, 'OFFLINE_KEY_REUSED');
        case 'full':
          return refused(503, 'OFFLINE_CAPACITY');
        case 'started':
          break;
      }
      let result: OfflineReplayOutcome<T>;
      try {
        result = await execute();
      } catch (error) {
        await store.abandon(key);
        throw error;
      }
      if (result.status >= 200 && result.status < 300)
        await store.complete(key, {
          status: result.status,
          body: result.body,
        });
      else await store.abandon(key);
      return {
        status: result.status,
        body: result.body,
        headers: {},
        outcome: 'executed',
      };
    },
  });
}
