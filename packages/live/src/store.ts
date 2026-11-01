import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  cloneState,
  freezeJson,
  isSnapshotToken,
  LiveProtocolError,
  type JsonValue,
} from './protocol.js';

/** Server-only reference to a keyed child mounted by a parent render. */
export interface ChildReference {
  readonly alias: string;
  readonly name: string;
  readonly id: string;
  readonly token: string;
}
/** Detached immutable public state; binding never appears in a browser snapshot. */
export interface StateSnapshot {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly state: Readonly<Record<string, JsonValue>>;
  readonly snapshot: string;
  readonly expiresAt: number;
  /** Server-only child bookkeeping; never serialized into a browser response. */
  readonly children?: Readonly<Record<string, ChildReference>>;
}
export interface LiveTransactionResult extends StateSnapshot {
  readonly html: string;
}
export interface MemoryLiveStoreOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  /** Test injection only: production tokens require 256 bits of cryptographic randomness. */
  readonly randomToken?: () => string;
  readonly randomId?: () => string;
}
interface Entry {
  snapshot: StateSnapshot;
  readonly bindingHash: Buffer;
  busy: boolean;
}
function unavailable(): never {
  throw new LiveProtocolError(
    'INVALID_SNAPSHOT',
    410,
    'Live state is unavailable; reload the page',
  );
}
function bindingHash(binding: string): Buffer {
  if (
    typeof binding !== 'string' ||
    binding.length === 0 ||
    Buffer.byteLength(binding) > 4096
  )
    unavailable();
  return createHash('sha256').update(binding).digest();
}
function frozenChildren(
  children: Readonly<Record<string, ChildReference>> | undefined,
): Readonly<Record<string, ChildReference>> | undefined {
  if (children === undefined) return undefined;
  const copy = Object.create(null) as Record<string, ChildReference>;
  for (const [key, child] of Object.entries(children))
    copy[key] = Object.freeze({
      alias: child.alias,
      name: child.name,
      id: child.id,
      token: child.token,
    });
  return Object.freeze(copy);
}
function frozenSnapshot(snapshot: StateSnapshot): StateSnapshot {
  const children = frozenChildren(snapshot.children);
  return Object.freeze({
    id: snapshot.id,
    name: snapshot.name,
    revision: snapshot.revision,
    state: freezeJson(cloneState(snapshot.state)),
    snapshot: snapshot.snapshot,
    expiresAt: snapshot.expiresAt,
    ...(children === undefined ? {} : { children }),
  });
}

/**
 * Single-process bounded state storage with reject-on-conflict serialization.
 * This is not a distributed lock or an exactly-once business transaction.
 */
export class MemoryLiveStore {
  readonly #entries = new Map<string, Entry>();
  #inFlight = 0;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #token: () => string;
  readonly #id: () => string;
  constructor(options: MemoryLiveStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 900_000;
    this.#maxEntries = options.maxEntries ?? 1000;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs < 1 ||
      this.#ttlMs > 86_400_000 ||
      !Number.isSafeInteger(this.#maxEntries) ||
      this.#maxEntries < 1 ||
      this.#maxEntries > 100_000
    ) {
      throw new LiveProtocolError(
        'INVALID_STORE_OPTIONS',
        500,
        'Invalid Live store capacity or TTL',
      );
    }
    this.#now = options.now ?? Date.now;
    this.#token =
      options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.#id = options.randomId ?? randomUUID;
  }
  #time(): number {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - this.#ttlMs
    )
      throw new LiveProtocolError(
        'INVALID_STORE_OPTIONS',
        500,
        'Invalid Live store clock',
      );
    return now;
  }
  #prune(): void {
    const now = this.#time();
    for (const [token, entry] of this.#entries)
      if (entry.snapshot.expiresAt <= now) this.#entries.delete(token);
  }
  #entry(token: string, binding: string): Entry {
    if (!isSnapshotToken(token)) unavailable();
    const hashed = bindingHash(binding);
    const entry = this.#entries.get(token);
    if (!entry) unavailable();
    if (entry.snapshot.expiresAt <= this.#time()) {
      this.#entries.delete(token);
      unavailable();
    }
    if (!timingSafeEqual(hashed, entry.bindingHash)) unavailable();
    return entry;
  }
  create(
    component: string,
    binding: string,
    state: Record<string, JsonValue>,
    children?: Readonly<Record<string, ChildReference>>,
  ): StateSnapshot {
    if (
      typeof component !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(component)
    )
      throw new LiveProtocolError(
        'INVALID_STATE',
        400,
        'Invalid Live component identifier',
      );
    const hashed = bindingHash(binding);
    const validated = freezeJson(cloneState(state));
    this.#prune();
    if (this.#entries.size >= this.#maxEntries)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live state capacity reached',
      );
    const token = this.#token();
    if (!isSnapshotToken(token) || this.#entries.has(token))
      throw new LiveProtocolError(
        'INVALID_STORE_OPTIONS',
        500,
        'Live token generator returned an invalid or duplicate token',
      );
    const id = this.#id();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new LiveProtocolError(
        'INVALID_STORE_OPTIONS',
        500,
        'Live identity generator returned an invalid UUID',
      );
    const references = frozenChildren(children);
    const snapshot: StateSnapshot = Object.freeze({
      id,
      name: component,
      revision: 0,
      state: validated,
      snapshot: token,
      expiresAt: this.#time() + this.#ttlMs,
      ...(references === undefined ? {} : { children: references }),
    });
    this.#entries.set(token, { snapshot, bindingHash: hashed, busy: false });
    return frozenSnapshot(snapshot);
  }
  peek(token: string, binding: string): StateSnapshot {
    return frozenSnapshot(this.#entry(token, binding).snapshot);
  }

  /** Lock and revision are checked before invoking the callback, without awaiting. */
  async transaction(
    token: string,
    binding: string,
    revision: number,
    callback: (snapshot: StateSnapshot) => Promise<{
      state: Record<string, JsonValue>;
      html: string;
      children?: Readonly<Record<string, ChildReference>>;
    }>,
  ): Promise<LiveTransactionResult> {
    const entry = this.#entry(token, binding);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision !== entry.snapshot.revision ||
      revision === Number.MAX_SAFE_INTEGER
    )
      throw new LiveProtocolError(
        'STALE_REVISION',
        409,
        'Live state revision conflict',
      );
    if (entry.busy)
      throw new LiveProtocolError(
        'COMPONENT_BUSY',
        409,
        'Live component has an action in progress',
      );
    // Expiry/revocation removes stored state, but cannot stop an arbitrary pending callback.
    // Keep a separate execution ceiling until those callbacks actually settle.
    if (this.#inFlight >= this.#maxEntries)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live action capacity reached',
      );
    entry.busy = true;
    this.#inFlight++;
    try {
      const result = await callback(frozenSnapshot(entry.snapshot));
      const state = freezeJson(cloneState(result.state));
      if (
        typeof result.html !== 'string' ||
        Buffer.byteLength(result.html) > 1_048_576
      )
        throw new LiveProtocolError(
          'PAYLOAD_TOO_LARGE',
          413,
          'Live rendered response exceeds limits',
        );
      // Revoke, deletion, expiry and clear during an action must not resurrect state.
      if (
        this.#entries.get(token) !== entry ||
        entry.snapshot.expiresAt <= this.#time()
      )
        unavailable();
      const references =
        result.children === undefined
          ? entry.snapshot.children
          : frozenChildren(result.children);
      entry.snapshot = Object.freeze({
        id: entry.snapshot.id,
        name: entry.snapshot.name,
        snapshot: entry.snapshot.snapshot,
        expiresAt: entry.snapshot.expiresAt,
        state,
        revision: revision + 1,
        ...(references === undefined ? {} : { children: references }),
      });
      return Object.freeze({
        ...frozenSnapshot(entry.snapshot),
        html: result.html,
      });
    } catch (error) {
      // The callback may already have committed an external effect. Invalidate instead of permitting retries.
      if (this.#entries.get(token) === entry) this.#entries.delete(token);
      throw error;
    } finally {
      entry.busy = false;
      this.#inFlight--;
    }
  }
  /** Host logout/session revocation must supply its authoritative binding. */
  revoke(binding: string): void {
    const hashed = bindingHash(binding);
    for (const [token, entry] of this.#entries)
      if (timingSafeEqual(hashed, entry.bindingHash))
        this.#entries.delete(token);
  }
  /** Host-only deletion; never expose this method as an unauthenticated browser endpoint. */
  delete(token: string): boolean {
    return this.#entries.delete(token);
  }
  clear(): void {
    this.#entries.clear();
  }
  get size(): number {
    this.#prune();
    return this.#entries.size;
  }
}
