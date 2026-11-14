export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
  /** Non-personal entries may be served stale until this time while refreshing. */
  readonly staleUntil: number;
  readonly tags: readonly string[];
}
type Awaitable<T> = T | Promise<T>;
/**
 * Pluggable store. Methods may be synchronous (memory) or asynchronous (a
 * network store); `Cache` awaits every call. Implementations must drop
 * entries after `staleUntil`, keep the tag index consistent with entries, and
 * treat keys as opaque (they never contain raw identity bindings).
 */
export interface CacheStore {
  get<T>(key: string): Awaitable<CacheEntry<T> | undefined>;
  set<T>(key: string, entry: CacheEntry<T>): Awaitable<void>;
  delete(key: string): Awaitable<void>;
  /** Delete every entry carrying one of the tags; returns the number removed. */
  invalidateTags(tags: readonly string[]): Awaitable<number>;
  clear(): Awaitable<void>;
}
/** Structural check: an object implementing every `CacheStore` method. */
export function isCacheStore(value: unknown): value is CacheStore {
  if (value === null || typeof value !== 'object') return false;
  return ['get', 'set', 'delete', 'invalidateTags', 'clear'].every(
    (method) => typeof Reflect.get(value, method) === 'function',
  );
}

/** Bounded LRU memory store with a tag index; single process only. */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, CacheEntry<unknown>>();
  readonly #tags = new Map<string, Set<string>>();
  constructor(
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error('Invalid cache capacity');
  }
  get<T>(key: string): CacheEntry<T> | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.staleUntil <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Refresh recency for LRU eviction.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry as CacheEntry<T>;
  }
  set<T>(key: string, entry: CacheEntry<T>): void {
    this.delete(key);
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.#entries.set(key, entry);
    for (const tag of entry.tags) {
      const keys = this.#tags.get(tag) ?? new Set();
      keys.add(key);
      this.#tags.set(tag, keys);
    }
  }
  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.#tags.get(tag);
      keys?.delete(key);
      if (keys && !keys.size) this.#tags.delete(tag);
    }
  }
  invalidateTags(tags: readonly string[]): number {
    let removed = 0;
    for (const tag of tags)
      for (const key of [...(this.#tags.get(tag) ?? [])]) {
        this.delete(key);
        removed++;
      }
    return removed;
  }
  clear(): void {
    this.#entries.clear();
    this.#tags.clear();
  }
  get size(): number {
    return this.#entries.size;
  }
}
