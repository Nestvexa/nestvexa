import { hardenInput } from './harden.js';
import type { FormValue, InputLimits } from './harden.js';

/** A stored draft. `version` increases by one on every accepted save. */
export interface Draft {
  readonly value: FormValue;
  readonly version: number;
  readonly savedAt: number;
  readonly expiresAt: number;
}

/**
 * Persistence for drafts. `compareAndSet` must be atomic: replace only when the
 * stored version equals `expectedVersion` (0 means "no draft").
 */
export interface DraftStore {
  get(key: string): Draft | undefined | Promise<Draft | undefined>;
  compareAndSet(
    key: string,
    expectedVersion: number,
    draft: Draft,
  ): boolean | Promise<boolean>;
  delete(key: string): void | Promise<void>;
}

/**
 * Process-memory draft store for development and tests. Bounded (default 1000
 * drafts, oldest evicted first); lost on restart and not shared between
 * processes. Use a database or Redis implementation in production.
 */
export class MemoryDraftStore implements DraftStore {
  readonly #drafts = new Map<string, Draft>();
  constructor(private readonly maxEntries = 1000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error('maxEntries must be a positive integer');
  }
  get(key: string): Draft | undefined {
    return this.#drafts.get(key);
  }
  compareAndSet(key: string, expectedVersion: number, draft: Draft): boolean {
    const current = this.#drafts.get(key);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.#drafts.delete(key);
    while (this.#drafts.size >= this.maxEntries) {
      const oldest = this.#drafts.keys().next();
      if (oldest.done) break;
      this.#drafts.delete(oldest.value);
    }
    this.#drafts.set(key, draft);
    return true;
  }
  delete(key: string): void {
    this.#drafts.delete(key);
  }
  get size(): number {
    return this.#drafts.size;
  }
}

export interface DraftManagerOptions {
  readonly store: DraftStore;
  /** Lifetime after the last save. Default 7 days; at most 30 days. */
  readonly ttlMs?: number;
  /** Maximum serialized draft size in bytes. Default 65536. */
  readonly maxBytes?: number;
  readonly limits?: InputLimits;
  /** Clock override for tests. */
  readonly now?: () => number;
}
export interface DraftSaveOptions {
  /** The version the editor started from (0 for a new draft). */
  readonly expectedVersion: number;
  /**
   * The user's explicit, host-recorded opt-in to server-side draft storage.
   * Saving without it is refused; there is no implicit autosave.
   */
  readonly consent: boolean;
}
export type DraftSaveResult =
  | { readonly ok: true; readonly version: number; readonly savedAt: number }
  | {
      readonly ok: false;
      readonly reason: 'conflict';
      /** The newer stored draft (undefined if it expired or was discarded). */
      readonly current: Draft | undefined;
    }
  | { readonly ok: false; readonly reason: 'too-large' | 'consent' };

export interface DraftManager {
  /** Load an unexpired draft. */
  load(owner: string, form: string): Promise<Draft | undefined>;
  /**
   * Save with optimistic concurrency: refused with `conflict` when another tab
   * or device saved since `expectedVersion`. Never overwrites newer work.
   */
  save(
    owner: string,
    form: string,
    value: unknown,
    options: DraftSaveOptions,
  ): Promise<DraftSaveResult>;
  /** Remove a draft (after a successful final submit or on explicit discard). */
  discard(owner: string, form: string): Promise<void>;
}

const day = 86_400_000;
function key(owner: string, form: string): string {
  if (
    typeof owner !== 'string' ||
    owner.length < 1 ||
    owner.length > 256 ||
    [...owner].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error('Draft owner must be a host-resolved identity string');
  if (typeof form !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(form))
    throw new Error('Draft form id must match [a-z][a-z0-9-]{0,63}');
  return JSON.stringify([form, owner]);
}

/**
 * Drafts keyed by a host-resolved owner (never a client-supplied id) and a form
 * id, with consent, size and lifetime limits and version-checked saves.
 */
export function createDraftManager(options: DraftManagerOptions): DraftManager {
  const ttl = options.ttlMs ?? 7 * day;
  const maxBytes = options.maxBytes ?? 65_536;
  const now = options.now ?? Date.now;
  if (!options.store) throw new Error('A draft store is required');
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 30 * day)
    throw new Error('Draft ttlMs must be 1 second to 30 days');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576)
    throw new Error('Draft maxBytes must be 1–1048576');
  const fresh = async (id: string): Promise<Draft | undefined> => {
    const draft = await options.store.get(id);
    if (!draft) return undefined;
    if (draft.expiresAt <= now()) {
      await options.store.delete(id);
      return undefined;
    }
    return draft;
  };
  const manager: DraftManager = {
    async load(owner, form) {
      return fresh(key(owner, form));
    },
    async save(owner, form, value, saveOptions) {
      const id = key(owner, form);
      if (saveOptions.consent !== true)
        return Object.freeze({
          ok: false as const,
          reason: 'consent' as const,
        });
      const expected = saveOptions.expectedVersion;
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new Error('expectedVersion must be a non-negative integer');
      const hardened = hardenInput(value, options.limits);
      if (Buffer.byteLength(JSON.stringify(hardened)) > maxBytes)
        return Object.freeze({
          ok: false as const,
          reason: 'too-large' as const,
        });
      const current = await fresh(id);
      if ((current?.version ?? 0) !== expected)
        return Object.freeze({
          ok: false as const,
          reason: 'conflict' as const,
          current,
        });
      const savedAt = now();
      const draft: Draft = Object.freeze({
        value: hardened,
        version: expected + 1,
        savedAt,
        expiresAt: savedAt + ttl,
      });
      if (!(await options.store.compareAndSet(id, expected, draft)))
        return Object.freeze({
          ok: false as const,
          reason: 'conflict' as const,
          current: await fresh(id),
        });
      return Object.freeze({
        ok: true as const,
        version: draft.version,
        savedAt,
      });
    },
    async discard(owner, form) {
      await options.store.delete(key(owner, form));
    },
  };
  return Object.freeze(manager);
}
