import type {
  ActionNotification,
  ActionRedirect,
  JsonValue,
} from './shared/protocol.js';

/** Successful action outcome retained for replay; never contains request ids or identity. */
export interface StoredActionOutcome {
  readonly data: JsonValue;
  readonly redirect?: ActionRedirect;
  readonly notifications?: readonly ActionNotification[];
}

export type IdempotencyBeginResult =
  | { readonly status: 'started' }
  | { readonly status: 'replay'; readonly outcome: StoredActionOutcome }
  | { readonly status: 'in-progress' }
  | { readonly status: 'mismatch' }
  | { readonly status: 'full' };

/**
 * Replay store contract. Keys are already scoped by tenant, subject, group,
 * action and version and hashed by the runtime. Implementations must make
 * `begin` atomic per key (a distributed store should use SET NX semantics).
 */
export interface ActionIdempotencyStore {
  begin(
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): IdempotencyBeginResult | Promise<IdempotencyBeginResult>;
  complete(key: string, outcome: StoredActionOutcome): void | Promise<void>;
  /** Releases an in-progress key after a failure so the client may retry. */
  abandon(key: string): void | Promise<void>;
  clear?(): void | Promise<void>;
}

export interface MemoryIdempotencyStoreOptions {
  /** Maximum retained keys (in-progress plus completed), default 10000. */
  readonly maxEntries?: number;
  /** Clock override for tests. */
  readonly now?: () => number;
}

interface Entry {
  readonly fingerprint: string;
  readonly expires: number;
  readonly outcome: StoredActionOutcome | undefined;
}

/**
 * Process-local bounded store. Completed entries expire after their TTL and
 * are evicted oldest-first when full; in-progress entries are never evicted,
 * so a full store of active work rejects new keys instead of losing locks.
 */
export class MemoryIdempotencyStore implements ActionIdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error(
        'Idempotency store maxEntries must be a positive integer',
      );
    this.#maxEntries = maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#entries)
      if (entry.expires <= now) this.#entries.delete(key);
  }

  begin(
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): IdempotencyBeginResult {
    const now = this.#now();
    const existing = this.#entries.get(key);
    if (existing && existing.expires > now) {
      if (existing.fingerprint !== fingerprint) return { status: 'mismatch' };
      return existing.outcome
        ? { status: 'replay', outcome: existing.outcome }
        : { status: 'in-progress' };
    }
    if (existing) this.#entries.delete(key);
    if (this.#entries.size >= this.#maxEntries) {
      this.#sweep(now);
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
      expires: now + ttlMs,
      outcome: undefined,
    });
    return { status: 'started' };
  }

  complete(key: string, outcome: StoredActionOutcome): void {
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

  clear(): void {
    this.#entries.clear();
  }
}
