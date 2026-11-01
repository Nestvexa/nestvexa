import { createHash } from 'node:crypto';

/**
 * Who may see a cached value. `public` values are identical for every visitor;
 * `private` values are bound to an identity binding (and tenant) in the key.
 */
export type CacheScope =
  | { readonly kind: 'public' }
  | {
      readonly kind: 'private';
      readonly binding: string;
      readonly tenant?: string;
    };
export interface CacheKeyParts {
  readonly scope: CacheScope;
  /** Logical namespace, for example `render:project-board` or `data:orders`. */
  readonly namespace: string;
  /** Renderer, locale, permission set, asset version, revision… anything output depends on. */
  readonly vary?: Readonly<Record<string, string | number | boolean | null>>;
}
const namespacePattern = /^[a-z][a-z0-9:._-]{0,127}$/;
const tagPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

/**
 * Deterministic key. Private scopes include a SHA-256 of the identity binding and
 * tenant, so a private value can never be read through another identity's key.
 */
export function cacheKey(parts: CacheKeyParts): string {
  if (!namespacePattern.test(parts.namespace))
    throw new Error('Invalid cache namespace');
  const scope =
    parts.scope.kind === 'public'
      ? 'public'
      : (() => {
          const { binding, tenant } = parts.scope;
          if (
            typeof binding !== 'string' ||
            binding.length < 16 ||
            binding.length > 1024
          )
            throw new Error(
              'Private cache entries require an identity binding',
            );
          if (tenant !== undefined && !namespacePattern.test(tenant))
            throw new Error('Invalid cache tenant');
          return (
            'private:' +
            createHash('sha256')
              .update(`${tenant ?? ''}\n${binding}`)
              .digest('base64url')
          );
        })();
  const vary = Object.entries(parts.vary ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))
        throw new Error('Invalid cache vary name');
      return `${name}=${JSON.stringify(value)}`;
    })
    .join('&');
  return `${parts.namespace}|${scope}|${createHash('sha256').update(vary).digest('base64url')}`;
}

export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
  /** Public entries may be served stale until this time while refreshing. */
  readonly staleUntil: number;
  readonly tags: readonly string[];
}
/** Pluggable store. Implementations must namespace keys and enforce TTLs. */
export interface CacheStore {
  get<T>(key: string): CacheEntry<T> | undefined;
  set<T>(key: string, entry: CacheEntry<T>): void;
  delete(key: string): void;
  /** Delete every entry carrying one of the tags; returns the number removed. */
  invalidateTags(tags: readonly string[]): number;
  clear(): void;
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

export interface CacheOptions {
  readonly ttlMs: number;
  /** Public scope only: serve the old value for this long while refreshing once. */
  readonly staleWhileRevalidateMs?: number;
  readonly tags?: readonly string[];
}
export interface CacheMetrics {
  hits: number;
  misses: number;
  stale: number;
  coalesced: number;
}

/**
 * Read-through cache with single-flight stampede protection. Values must be
 * JSON data; they are cloned on write and read so callers cannot mutate entries.
 */
export class Cache {
  readonly metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    stale: 0,
    coalesced: 0,
  };
  /** In-flight computations resolve JSON text; every caller parses its own copy. */
  readonly #inflight = new Map<string, Promise<string>>();
  constructor(
    readonly store: CacheStore = new MemoryCacheStore(),
    private readonly now: () => number = Date.now,
    /** Called after tag invalidation, for example to publish realtime events. */
    private readonly onInvalidate?: (
      tags: readonly string[],
    ) => void | Promise<void>,
  ) {}
  async get<T>(
    parts: CacheKeyParts,
    options: CacheOptions,
    compute: () => Promise<T> | T,
  ): Promise<T> {
    const key = cacheKey(parts);
    if (
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < 1 ||
      options.ttlMs > 86_400_000
    )
      throw new Error('Cache ttlMs must be 1 ms to 24 hours');
    const swr = options.staleWhileRevalidateMs ?? 0;
    if (swr && parts.scope.kind !== 'public')
      throw new Error(
        'stale-while-revalidate is only allowed for public cache entries',
      );
    const tags = [...new Set(options.tags ?? [])];
    for (const tag of tags)
      if (!tagPattern.test(tag)) throw new Error('Invalid cache tag');
    const entry = this.store.get<string>(key);
    const now = this.now();
    if (entry && entry.expiresAt > now) {
      this.metrics.hits++;
      return JSON.parse(entry.value) as T;
    }
    const refresh = (): Promise<T> => {
      const pending = this.#inflight.get(key);
      if (pending) {
        this.metrics.coalesced++;
        return pending.then((text) => JSON.parse(text) as T);
      }
      const started = (async () => {
        try {
          const value = await compute();
          const text = JSON.stringify(value);
          if (text === undefined)
            throw new Error('Cached values must be JSON data');
          const at = this.now();
          this.store.set(key, {
            value: text,
            expiresAt: at + options.ttlMs,
            staleUntil: at + options.ttlMs + swr,
            tags,
          });
          return text;
        } finally {
          this.#inflight.delete(key);
        }
      })();
      this.#inflight.set(key, started);
      return started.then((text) => JSON.parse(text) as T);
    };
    if (entry && swr) {
      this.metrics.stale++;
      void refresh().catch(() => undefined);
      return JSON.parse(entry.value) as T;
    }
    this.metrics.misses++;
    return refresh();
  }
  /** Invalidate tagged entries and notify dependents (for example realtime channels). */
  async invalidate(tags: readonly string[]): Promise<number> {
    for (const tag of tags)
      if (!tagPattern.test(tag)) throw new Error('Invalid cache tag');
    const removed = this.store.invalidateTags(tags);
    await this.onInvalidate?.(tags);
    return removed;
  }
}

/**
 * Conservative dependency graph: map data tags to realtime channels so that a
 * write invalidating `orders:tenant-a` refreshes components declaring the same
 * tag channel with `@RealtimeChannels()`. No automatic dependency detection.
 */
export function tagChannel(tag: string): string {
  if (!tagPattern.test(tag) || tag.length > 124)
    throw new Error('Invalid cache tag for a realtime channel');
  return `tag:${tag}`;
}
