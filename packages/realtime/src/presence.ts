import type { PresenceMember } from './hub.js';

/** One replica's presence on one channel, as a shared store returns it. */
export interface PresenceEntry {
  /** Replica id that wrote the entry. */
  readonly replica: string;
  /** Up to `maxPresenceMembers` members sorted by id. Untrusted: re-validated by readers. */
  readonly members: readonly unknown[];
  /** Distinct members connected to that replica, before truncation. */
  readonly total: number;
}
/**
 * Shared presence for multiple replicas. Each replica replaces its own entry
 * per channel; an entry that is not written again within its TTL lapses, so a
 * replica that dies without cleaning up disappears from presence on its own.
 */
export interface PresenceStore {
  write(
    replica: string,
    channel: string,
    entry: {
      readonly members: readonly PresenceMember[];
      readonly total: number;
    },
    ttlMs: number,
  ): Promise<void>;
  remove(replica: string, channel: string): Promise<void>;
  /** Unexpired entries for `channel`, from every replica. */
  read(channel: string): Promise<readonly PresenceEntry[]>;
  close(): Promise<void>;
}
export interface RealtimePresenceOptions {
  readonly store: PresenceStore;
  /**
   * Entry lifetime (default 30 s, 3–600 s). Entries are rewritten every
   * third of it, so a crashed replica's members vanish within one TTL.
   */
  readonly ttlMs?: number;
}

/**
 * Process-local `PresenceStore`: lets several `RealtimeService` instances in
 * one process (tests, workers) share presence. Use `RedisPresenceStore` from
 * `@nestvexa/realtime-redis/realtime` across processes.
 */
export class MemoryPresenceStore implements PresenceStore {
  readonly #channels = new Map<
    string,
    Map<string, { entry: PresenceEntry; expiresAt: number }>
  >();
  readonly #now: () => number;
  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }
  async write(
    replica: string,
    channel: string,
    entry: {
      readonly members: readonly PresenceMember[];
      readonly total: number;
    },
    ttlMs: number,
  ): Promise<void> {
    const replicas = this.#channels.get(channel) ?? new Map();
    replicas.set(replica, {
      entry: Object.freeze({
        replica,
        members: Object.freeze([...entry.members]),
        total: entry.total,
      }),
      expiresAt: this.#now() + ttlMs,
    });
    this.#channels.set(channel, replicas);
  }
  async remove(replica: string, channel: string): Promise<void> {
    const replicas = this.#channels.get(channel);
    replicas?.delete(replica);
    if (replicas && !replicas.size) this.#channels.delete(channel);
  }
  async read(channel: string): Promise<readonly PresenceEntry[]> {
    const replicas = this.#channels.get(channel);
    if (!replicas) return [];
    const now = this.#now();
    const entries: PresenceEntry[] = [];
    for (const [replica, { entry, expiresAt }] of replicas)
      if (expiresAt > now) entries.push(entry);
      else replicas.delete(replica);
    return entries;
  }
  async close(): Promise<void> {
    this.#channels.clear();
  }
}
