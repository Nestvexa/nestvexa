import { cacheKey, tagPattern } from './keys.js';
import type { CacheKeyParts, CacheScope } from './keys.js';
import { MemoryCacheStore, isCacheStore } from './store.js';
import type { CacheEntry, CacheStore } from './store.js';

export interface CacheOptions {
  readonly ttlMs: number;
  /**
   * Public and tenant scopes only: serve the old value for this long after
   * `ttlMs` while one background refresh runs. Refused for private scopes.
   */
  readonly staleWhileRevalidateMs?: number;
  readonly tags?: readonly string[];
}
export interface CacheMetrics {
  hits: number;
  misses: number;
  stale: number;
  coalesced: number;
  /** Render requests answered without the cache (private HTML by default). */
  bypassed: number;
  /** Values refused because they carry signed per-user material. */
  refused: number;
  /** Computed values not stored because a tag was invalidated meanwhile. */
  discarded: number;
  /** Failed computations, background refreshes and store calls. */
  errors: number;
  invalidations: number;
}
/** Outcome of one lookup. `bypass` comes from `RenderCache` only. */
export type CacheStatus = 'hit' | 'miss' | 'stale' | 'coalesced' | 'bypass';
/**
 * Telemetry event. Carries the namespace, scope kind, tags and timings only:
 * never keys, bindings, tenants or values.
 */
export interface CacheEvent {
  readonly type:
    | 'hit'
    | 'miss'
    | 'stale'
    | 'coalesced'
    | 'bypass'
    | 'refused'
    | 'discarded'
    | 'compute-error'
    | 'refresh-error'
    | 'store-error'
    | 'invalidate';
  readonly namespace?: string;
  readonly scope?: CacheScope['kind'];
  /** Computation time for `miss`, `stale` refreshes and errors. */
  readonly durationMs?: number;
  /** Why a request bypassed the cache or a value was refused. */
  readonly reason?: string;
  readonly tags?: readonly string[];
  /** Entries removed by `invalidate`. */
  readonly removed?: number;
}
/**
 * Structural span API, compatible with `LiveInstrumentation` from
 * `@nestvexa/observability` (for example its OpenTelemetry bridge).
 */
export interface CacheInstrumentation {
  start(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
  ): {
    end(
      outcome: 'ok' | 'error',
      attributes?: Readonly<Record<string, string | number | boolean>>,
    ): void;
  };
}
export interface CacheConfig {
  readonly store?: CacheStore;
  readonly now?: () => number;
  /** Called after tag invalidation, for example to publish realtime events. */
  readonly onInvalidate?: (tags: readonly string[]) => void | Promise<void>;
  /** Performance telemetry; exceptions thrown by the hook are ignored. */
  readonly onEvent?: (event: CacheEvent) => void;
  /** One span per computation (`nestvexa.cache.compute`). */
  readonly instrumentation?: CacheInstrumentation;
}
export interface CacheLookup<T> {
  readonly value: T;
  readonly status: CacheStatus;
}

/**
 * Thrown instead of caching a value that carries signed per-user material: a
 * Live snapshot token, a CSRF token or signed island props. Such values are
 * bound to one identity and revision; caching them would hand one user's
 * bearer token to another or replay a stale revision. Render Live components
 * and forms outside cached fragments instead.
 */
export class CacheRefusedError extends Error {
  constructor(readonly reason: string) {
    super(
      `Refusing to cache a value containing ${reason}; render it outside the cached fragment`,
    );
    this.name = 'CacheRefusedError';
  }
}
const signedMarkers: readonly (readonly [RegExp, string])[] = [
  [/data-nv-snapshot/i, 'a Live snapshot token (data-nv-snapshot)'],
  [/data-nv-csrf/i, 'a Live CSRF token (data-nv-csrf)'],
  [/data-nv-props-token/i, 'signed island props (data-nv-props-token)'],
  [
    /name=\\?["']?_csrf\b|name=\\?["']?csrf[-_]?token\b|csrf-token/i,
    'a CSRF token field',
  ],
];
const snapshotToken = /^[A-Za-z0-9_-]{43}$/;
/**
 * JSON text of `value`, refusing signed per-user material: the markers above
 * anywhere in the text, or an object shaped like a Live `StateSnapshot`
 * (a 256-bit `snapshot` token next to a numeric `revision`).
 */
export function cacheableJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof Reflect.get(item, 'revision') === 'number'
    ) {
      const token: unknown = Reflect.get(item, 'snapshot');
      if (typeof token === 'string' && snapshotToken.test(token))
        throw new CacheRefusedError('a Live state snapshot');
    }
    return item;
  });
  if (text === undefined) throw new Error('Cached values must be JSON data');
  for (const [pattern, reason] of signedMarkers)
    if (pattern.test(text)) throw new CacheRefusedError(reason);
  return text;
}

function assertOptions(parts: CacheKeyParts, options: CacheOptions): void {
  if (
    !Number.isSafeInteger(options.ttlMs) ||
    options.ttlMs < 1 ||
    options.ttlMs > 86_400_000
  )
    throw new Error('Cache ttlMs must be 1 ms to 24 hours');
  const swr = options.staleWhileRevalidateMs ?? 0;
  if (!Number.isSafeInteger(swr) || swr < 0 || swr > 86_400_000)
    throw new Error('Cache staleWhileRevalidateMs must be 0 ms to 24 hours');
  if (swr && parts.scope.kind === 'private')
    throw new Error(
      'stale-while-revalidate is only allowed for public or tenant (non-personal) cache entries',
    );
  for (const tag of options.tags ?? [])
    if (!tagPattern.test(tag)) throw new Error('Invalid cache tag');
}

/**
 * Read-through cache with per-key single-flight stampede protection.
 *
 * - Values must be JSON data; they are cloned on write and read, so callers
 *   never share objects, and values carrying signed per-user material are
 *   refused (`CacheRefusedError`).
 * - Concurrent misses for one key run one computation; keys separate scopes,
 *   so identities and tenants never share a computation, value or failure.
 * - Failures are not cached. A computation that overlaps an invalidation of
 *   one of its tags returns its value but does not store it.
 * - Store failures degrade to computing (reads) or not storing (writes) and
 *   are reported as `store-error`; invalidation failures propagate.
 */
export class Cache {
  readonly metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    stale: 0,
    coalesced: 0,
    bypassed: 0,
    refused: 0,
    discarded: 0,
    errors: 0,
    invalidations: 0,
  };
  readonly store: CacheStore;
  readonly #now: () => number;
  readonly #onInvalidate:
    | ((tags: readonly string[]) => void | Promise<void>)
    | undefined;
  readonly #onEvent: ((event: CacheEvent) => void) | undefined;
  readonly #instrumentation: CacheInstrumentation | undefined;
  /** In-flight computations resolve JSON text; every caller parses its own copy. */
  readonly #inflight = new Map<string, Promise<string>>();
  /** Invalidation counter and, while computations run, each tag's last value. */
  #generation = 0;
  readonly #invalidated = new Map<string, number>();
  /**
   * `new Cache({ store, now, onInvalidate, onEvent, instrumentation })`, or
   * the positional form `new Cache(store?, now?, onInvalidate?)`.
   */
  constructor(
    storeOrConfig?: CacheStore | CacheConfig,
    now?: () => number,
    onInvalidate?: (tags: readonly string[]) => void | Promise<void>,
  ) {
    const config: CacheConfig =
      storeOrConfig === undefined || isCacheStore(storeOrConfig)
        ? {
            ...(storeOrConfig === undefined ? {} : { store: storeOrConfig }),
            ...(now === undefined ? {} : { now }),
            ...(onInvalidate === undefined ? {} : { onInvalidate }),
          }
        : storeOrConfig;
    if (config === storeOrConfig && (now ?? onInvalidate) !== undefined)
      throw new Error('Pass now and onInvalidate inside the Cache options');
    this.store = config.store ?? new MemoryCacheStore();
    this.#now = config.now ?? Date.now;
    this.#onInvalidate = config.onInvalidate;
    this.#onEvent = config.onEvent;
    this.#instrumentation = config.instrumentation;
  }
  /** Report a telemetry event; the hook can never break a request. */
  emit(event: CacheEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Telemetry failures are not request failures.
    }
  }
  async get<T>(
    parts: CacheKeyParts,
    options: CacheOptions,
    compute: () => Promise<T> | T,
  ): Promise<T> {
    return (await this.lookup(parts, options, compute)).value;
  }
  /** Like `get`, also reporting whether the value was a hit, miss, stale or coalesced. */
  async lookup<T>(
    parts: CacheKeyParts,
    options: CacheOptions,
    compute: () => Promise<T> | T,
  ): Promise<CacheLookup<T>> {
    const key = cacheKey(parts);
    assertOptions(parts, options);
    const swr = options.staleWhileRevalidateMs ?? 0;
    const tags = [...new Set(options.tags ?? [])];
    const base = { namespace: parts.namespace, scope: parts.scope.kind };
    let entry: CacheEntry<string> | undefined;
    try {
      entry = await this.store.get<string>(key);
    } catch {
      this.metrics.errors++;
      this.emit({ type: 'store-error', ...base, reason: 'get' });
    }
    const now = this.#now();
    if (entry && entry.expiresAt > now) {
      this.metrics.hits++;
      this.emit({ type: 'hit', ...base });
      return { value: JSON.parse(entry.value) as T, status: 'hit' };
    }
    const refresh = (reason: 'miss' | 'refresh'): Promise<string> => {
      const started = this.#generation;
      const span = this.#span(parts, reason);
      const at = this.#now();
      const running = (async () => {
        try {
          const text = cacheableJson(await compute());
          const durationMs = Math.max(0, this.#now() - at);
          span?.end('ok', { 'nestvexa.cache.duration_ms': durationMs });
          if (reason === 'miss')
            this.emit({ type: 'miss', ...base, durationMs });
          if (
            tags.some((tag) => (this.#invalidated.get(tag) ?? -1) > started)
          ) {
            this.metrics.discarded++;
            this.emit({ type: 'discarded', ...base, tags });
            return text;
          }
          const stored = this.#now();
          try {
            await this.store.set(key, {
              value: text,
              expiresAt: stored + options.ttlMs,
              staleUntil: stored + options.ttlMs + swr,
              tags,
            });
          } catch {
            this.metrics.errors++;
            this.emit({ type: 'store-error', ...base, reason: 'set' });
          }
          return text;
        } catch (error) {
          const durationMs = Math.max(0, this.#now() - at);
          span?.end('error', { 'nestvexa.cache.duration_ms': durationMs });
          if (error instanceof CacheRefusedError) {
            this.metrics.refused++;
            this.emit({ type: 'refused', ...base, reason: error.reason });
          } else {
            this.metrics.errors++;
            this.emit({
              type: reason === 'miss' ? 'compute-error' : 'refresh-error',
              ...base,
              durationMs,
            });
          }
          throw error;
        } finally {
          this.#inflight.delete(key);
          if (!this.#inflight.size) this.#invalidated.clear();
        }
      })();
      this.#inflight.set(key, running);
      return running;
    };
    const pending = this.#inflight.get(key);
    if (entry && swr) {
      this.metrics.stale++;
      this.emit({ type: 'stale', ...base });
      if (!pending) void refresh('refresh').catch(() => undefined);
      return { value: JSON.parse(entry.value) as T, status: 'stale' };
    }
    if (pending) {
      this.metrics.coalesced++;
      this.emit({ type: 'coalesced', ...base });
      return { value: JSON.parse(await pending) as T, status: 'coalesced' };
    }
    this.metrics.misses++;
    return { value: JSON.parse(await refresh('miss')) as T, status: 'miss' };
  }
  #span(parts: CacheKeyParts, reason: 'miss' | 'refresh') {
    try {
      return this.#instrumentation?.start('nestvexa.cache.compute', {
        'nestvexa.cache.namespace': parts.namespace,
        'nestvexa.cache.scope': parts.scope.kind,
        'nestvexa.cache.reason': reason,
      });
    } catch {
      return undefined;
    }
  }
  /** Invalidate tagged entries and notify dependents (for example realtime channels). */
  async invalidate(tags: readonly string[]): Promise<number> {
    for (const tag of tags)
      if (!tagPattern.test(tag)) throw new Error('Invalid cache tag');
    // Computations already running for these tags must not store old data.
    this.#generation++;
    if (this.#inflight.size)
      for (const tag of tags) this.#invalidated.set(tag, this.#generation);
    const removed = await this.store.invalidateTags(tags);
    this.metrics.invalidations++;
    this.emit({ type: 'invalidate', tags: [...tags], removed });
    await this.#onInvalidate?.(tags);
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
