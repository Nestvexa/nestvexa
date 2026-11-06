import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { LiveProtocolError } from './protocol.js';
import type { JsonValue, LiveRequest } from './protocol.js';

const replayLifetime = 300_000;
const maxReplays = 1_000;
const maxLocks = 10_000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
/** Deterministic JSON with sorted keys, used only for fingerprints. */
function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/**
 * Bounded single-process store of committed idempotent responses (the
 * default; see {@link sharedActionPolicy} for replicas). Keys bind
 * the identity, state reference and request ID; the fingerprint binds the
 * component, action, revision, updates and input of the original request.
 */
export class ActionReplayCache {
  readonly #entries = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly response: object;
      expiresAt: number;
    }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  #key(binding: string, payload: LiveRequest): string {
    return digest(
      `${binding}\u0000${payload.snapshot}\u0000${payload.requestId}`,
    );
  }
  #fingerprint(
    component: string,
    action: string,
    payload: LiveRequest,
  ): string {
    return fingerprintOf(component, action, payload);
  }
  #prune(): void {
    const now = this.now();
    for (const [key, entry] of this.#entries)
      if (entry.expiresAt <= now) this.#entries.delete(key);
  }

  /** Stored response for an identical retry; throws for a reused ID with another payload. */
  lookup(
    binding: string,
    component: string,
    action: string,
    payload: LiveRequest,
  ): object | undefined {
    this.#prune();
    const entry = this.#entries.get(this.#key(binding, payload));
    if (!entry) return undefined;
    if (entry.fingerprint !== this.#fingerprint(component, action, payload))
      throw new LiveProtocolError(
        'IDEMPOTENCY_CONFLICT',
        422,
        'Live request ID was reused with a different payload',
      );
    return entry.response;
  }

  remember(
    binding: string,
    component: string,
    action: string,
    payload: LiveRequest,
    response: object,
  ): void {
    this.#prune();
    // Oldest-first eviction: an evicted retry fails safely with STALE_REVISION.
    while (this.#entries.size >= maxReplays) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(this.#key(binding, payload), {
      fingerprint: this.#fingerprint(component, action, payload),
      response: Object.freeze({ ...response, replayed: true }),
      expiresAt: this.now() + replayLifetime,
    });
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Identity-scoped exclusive action locks; overlapping calls are rejected, never queued. */
export class ActionLocks {
  readonly #held = new Set<string>();

  acquire(binding: string, component: string, action: string): () => void {
    const key = digest(`${binding}\u0000${component}\u0000${action}`);
    if (this.#held.has(key))
      throw new LiveProtocolError(
        'ACTION_BUSY',
        409,
        'This action is already running for the current identity',
      );
    if (this.#held.size >= maxLocks)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live action capacity reached',
      );
    this.#held.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held.delete(key);
    };
  }

  get size(): number {
    return this.#held.size;
  }
}

/**
 * Optional store capability that shares idempotent replay records and
 * per-identity action leases between replicas. A `LiveStateStore` that also
 * implements these four methods (for example `RedisLiveStore`) is detected
 * structurally; otherwise both stay process-local.
 *
 * Keys are SHA-256 digests (43 base64url characters) that never contain raw
 * identities or snapshot tokens. Replay values are opaque sealed strings:
 * AES-256-GCM ciphertext under a key derived from the original request's
 * identity binding, snapshot token and request ID, none of which the store
 * holds, so a store reader cannot recover the stored response.
 */
export interface LiveActionCoordination {
  readReplay(key: string): Promise<string | undefined> | string | undefined;
  /** Store (or overwrite) a sealed record for `ttlMs` milliseconds. */
  writeReplay(key: string, value: string, ttlMs: number): Promise<void> | void;
  /** Take an exclusive lease for `ttlMs`; false when another owner holds it. */
  acquireActionLease(
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> | boolean;
  /** Release the lease only if `owner` still holds it. */
  releaseActionLease(key: string, owner: string): Promise<void> | void;
}

/** Whether `value` implements {@link LiveActionCoordination}. */
export function isLiveActionCoordination(
  value: unknown,
): value is LiveActionCoordination {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['readReplay', 'writeReplay', 'acquireActionLease', 'releaseActionLease']
      .map((name): unknown => Reflect.get(value, name))
      .every((method) => typeof method === 'function')
  );
}

/** The runtime's view of replay and locking, process-local or shared. */
export interface ActionPolicy {
  /** True when records and leases are shared through the configured store. */
  readonly shared: boolean;
  lookup(
    binding: string,
    component: string,
    action: string,
    payload: LiveRequest,
  ): Promise<object | undefined>;
  remember(
    binding: string,
    component: string,
    action: string,
    payload: LiveRequest,
    response: object,
  ): Promise<void>;
  /** Resolves to a release function, or rejects with 409 ACTION_BUSY. */
  acquire(
    binding: string,
    component: string,
    action: string,
    leaseMs: number,
  ): Promise<() => Promise<void>>;
  clear(): void;
}

/** Default single-process policy over {@link ActionReplayCache} and {@link ActionLocks}. */
export function memoryActionPolicy(): ActionPolicy {
  const replays = new ActionReplayCache();
  const locks = new ActionLocks();
  return {
    shared: false,
    lookup: async (binding, component, action, payload) =>
      replays.lookup(binding, component, action, payload),
    remember: async (binding, component, action, payload, response) => {
      replays.remember(binding, component, action, payload, response);
    },
    acquire: async (binding, component, action) => {
      const release = locks.acquire(binding, component, action);
      return async () => release();
    },
    clear: () => replays.clear(),
  };
}

const sealedPattern = /^r1\.[A-Za-z0-9_-]{40,6000000}$/;
function replayMaterial(binding: string, payload: LiveRequest): string {
  return `${binding}\u0000${payload.snapshot}\u0000${payload.requestId}`;
}
function replayKey(binding: string, payload: LiveRequest): string {
  return digest(
    `nestvexa-live-replay-id\u0000${replayMaterial(binding, payload)}`,
  );
}
function sealingKey(binding: string, payload: LiveRequest): Buffer {
  return createHash('sha256')
    .update(`nestvexa-live-replay-key\u0000${replayMaterial(binding, payload)}`)
    .digest();
}
function fingerprintOf(
  component: string,
  action: string,
  payload: LiveRequest,
): string {
  return digest(
    canonical({
      component,
      action,
      revision: payload.revision,
      updates: payload.updates,
      input: payload.input ?? null,
    }),
  );
}
function seal(key: Buffer, storageKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // The storage key is authenticated: a record copied to another key fails.
  cipher.setAAD(Buffer.from(storageKey));
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return `r1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}
/** Plaintext of a sealed record, or undefined when it is malformed or was tampered with. */
function unseal(
  key: Buffer,
  storageKey: string,
  sealed: string,
): string | undefined {
  if (!sealedPattern.test(sealed)) return undefined;
  const bytes = Buffer.from(sealed.slice(3), 'base64url');
  if (bytes.length < 29) return undefined;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(storageKey));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Policy over a shared {@link LiveActionCoordination} store: an idempotent
 * retry replays on any replica, and an `identity` lock excludes overlapping
 * executions across replicas. Leases expire after `leaseMs`, so a crashed
 * replica cannot hold an action forever.
 */
export function sharedActionPolicy(
  store: LiveActionCoordination,
): ActionPolicy {
  return {
    shared: true,
    async lookup(binding, component, action, payload) {
      const key = replayKey(binding, payload);
      const sealed: unknown = await store.readReplay(key);
      if (typeof sealed !== 'string') return undefined;
      const text = unseal(sealingKey(binding, payload), key, sealed);
      // An unreadable record behaves like an evicted one: the retry then
      // fails safely with STALE_REVISION instead of replaying foreign data.
      if (text === undefined) return undefined;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        return undefined;
      }
      if (!record || typeof record !== 'object') return undefined;
      const fingerprint: unknown = Reflect.get(record, 'f');
      const response: unknown = Reflect.get(record, 'r');
      if (
        typeof fingerprint !== 'string' ||
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response)
      )
        return undefined;
      if (fingerprint !== fingerprintOf(component, action, payload))
        throw new LiveProtocolError(
          'IDEMPOTENCY_CONFLICT',
          422,
          'Live request ID was reused with a different payload',
        );
      return Object.freeze({ ...response, replayed: true });
    },
    async remember(binding, component, action, payload, response) {
      const key = replayKey(binding, payload);
      const sealed = seal(
        sealingKey(binding, payload),
        key,
        JSON.stringify({
          f: fingerprintOf(component, action, payload),
          r: response,
        }),
      );
      try {
        await store.writeReplay(key, sealed, replayLifetime);
      } catch {
        // The action already committed. Without a record a retry fails
        // safely with STALE_REVISION; the committed response still returns.
      }
    },
    async acquire(binding, component, action, leaseMs) {
      const key = digest(`${binding}\u0000${component}\u0000${action}`);
      const owner = randomBytes(18).toString('base64url');
      if (!(await store.acquireActionLease(key, owner, leaseMs)))
        throw new LiveProtocolError(
          'ACTION_BUSY',
          409,
          'This action is already running for the current identity',
        );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await store.releaseActionLease(key, owner);
        } catch {
          // Unreachable store: the lease expires after leaseMs.
        }
      };
    },
    clear: () => undefined,
  };
}
