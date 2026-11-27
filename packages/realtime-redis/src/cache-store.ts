import { createHash, randomBytes } from 'node:crypto';
import { cacheableJson } from '@nestvexa/cache';
import type { CacheEntry, CacheLock, CacheStore } from '@nestvexa/cache';
import { atomic, connectionOptions } from './atomic.js';
import { expectReply, RespConnection } from './resp.js';
import type { RespConnectionOptions, RespReply } from './resp.js';

export interface RedisCacheStoreOptions extends RespConnectionOptions {
  /** Key prefix isolating one application/environment on a shared server. */
  readonly prefix?: string;
  /**
   * Entries kept in the shared index (default 50000, 1 to 10 million). When
   * a write goes over it, expired entries and then the entries closest to
   * expiry are evicted. Configure Redis `maxmemory` as the hard memory bound.
   */
  readonly maxEntries?: number;
  /** Largest stored entry in UTF-8 JSON bytes (default 1 MiB, at most 6 MiB). */
  readonly maxEntryBytes?: number;
  readonly now?: () => number;
}

/** Tags carried by one entry (`Cache` validates the tag pattern). */
const maxTags = 64;
const tagPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
/** Tag index sets outlive any entry (TTL plus stale-while-revalidate is at most 48 h). */
const tagIndexTtlMs = 172_800_000;
/** Invalidation counters outlive every entry written before them. */
const epochTtlMs = 604_800_000;
/** Entries removed per eviction or clear round. */
const batch = 256;

function invalid(message: string): never {
  throw new Error(`Redis cache store: ${message}`);
}
/** Redis failures keep their cause for logs; messages never carry keys or values. */
function unavailable(cause: unknown): never {
  const error = new Error('Cache store is unavailable');
  Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
/**
 * Defence in depth behind `Cache`: values carrying a Live snapshot token, a
 * CSRF token or signed island props are refused before they reach Redis,
 * including JSON text written by `Cache` itself.
 */
function refuseSigned(value: unknown): void {
  cacheableJson(value);
  if (typeof value !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  cacheableJson(parsed);
}
function epochOf(reply: RespReply | undefined): number {
  if (reply === null || reply === undefined) return 0;
  const value = Number(reply);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * Shared `CacheStore` for multiple instances over RESP, with no client
 * library:
 *
 * - entries live under `<prefix>e:<sha256(key)>` with `PX` set to their
 *   `staleUntil`, so Redis expires them; keys from `cacheKey` are opaque and
 *   only their hash reaches Redis;
 * - each tag has an index set and an invalidation counter. `invalidateTags`
 *   bumps the counter first, so every instance stops serving the tagged
 *   entries at once (reads compare the counters recorded in the entry), then
 *   deletes the indexed entries;
 * - `tagMarker` + `set(key, entry, marker)` discard a value whose
 *   computation overlapped an invalidation on any instance
 *   (`WATCH`/`MULTI`/`EXEC` on the counters);
 * - `lock` is a short `SET NX PX` lease so one instance computes a key
 *   while the others wait for its value (cross-process stampede
 *   protection in `Cache`);
 * - size bounds: `maxEntryBytes` per entry, `maxEntries` in the index;
 * - values with signed per-user material are refused (`CacheRefusedError`).
 *
 * Targets a single Redis primary (standalone or Sentinel-managed). Redis
 * Cluster is not supported: writes span keys in different hash slots.
 */
export class RedisCacheStore implements CacheStore {
  readonly #commands: RespConnection;
  /** Dedicated connection: WATCH/MULTI state is connection-scoped. */
  readonly #transactions: RespConnection;
  readonly #prefix: string;
  readonly #maxEntries: number;
  readonly #maxEntryBytes: number;
  readonly #now: () => number;

  constructor(options: RedisCacheStoreOptions = {}) {
    this.#prefix = options.prefix ?? 'nestvexa:cache:';
    if (!/^[a-z0-9:._-]{0,64}$/.test(this.#prefix)) invalid('invalid prefix');
    const maxEntries = options.maxEntries ?? 50_000;
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 10_000_000
    )
      invalid('invalid maxEntries');
    const maxEntryBytes = options.maxEntryBytes ?? 1_048_576;
    if (
      !Number.isSafeInteger(maxEntryBytes) ||
      maxEntryBytes < 64 ||
      maxEntryBytes > 6_291_456
    )
      invalid('invalid maxEntryBytes');
    this.#maxEntries = maxEntries;
    this.#maxEntryBytes = maxEntryBytes;
    this.#now = options.now ?? Date.now;
    const connection = connectionOptions(options);
    this.#commands = new RespConnection(connection);
    this.#transactions = new RespConnection(connection);
  }

  #entryKey(id: string): string {
    return `${this.#prefix}e:${id}`;
  }
  #lockKey(id: string): string {
    return `${this.#prefix}l:${id}`;
  }
  #tagKey(tag: string): string {
    return `${this.#prefix}t:${tag}`;
  }
  #epochKey(tag: string): string {
    return `${this.#prefix}g:${tag}`;
  }
  /** Sorted set of entry ids scored by `staleUntil` (eviction order). */
  #indexKey(): string {
    return `${this.#prefix}i`;
  }
  /** Every tag that has an index set (for `clear`). */
  #tagsKey(): string {
    return `${this.#prefix}ts`;
  }
  #id(key: string): string {
    if (typeof key !== 'string' || key === '') invalid('invalid key');
    return hash(key);
  }
  #tags(tags: unknown): readonly string[] {
    if (!Array.isArray(tags) || tags.length > maxTags) invalid('invalid tags');
    for (const tag of tags as unknown[])
      if (typeof tag !== 'string' || !tagPattern.test(tag))
        invalid('invalid tag');
    return [...new Set(tags as string[])];
  }
  async #command(...parts: string[]): Promise<RespReply> {
    try {
      return expectReply(await this.#commands.command(...parts));
    } catch (error) {
      unavailable(error);
    }
  }
  async #atomic(
    watch: readonly string[],
    plan: (
      run: (...parts: string[]) => Promise<RespReply>,
    ) => Promise<readonly (readonly string[])[] | null>,
  ): Promise<RespReply[] | null> {
    try {
      return await atomic(this.#transactions, watch, plan);
    } catch (error) {
      unavailable(error);
    }
  }
  async #epochs(tags: readonly string[]): Promise<number[]> {
    return Promise.all(
      tags.map(async (tag) =>
        epochOf(await this.#command('GET', this.#epochKey(tag))),
      ),
    );
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const id = this.#id(key);
    const raw = await this.#command('GET', this.#entryKey(id));
    if (typeof raw !== 'string') return undefined;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      record = undefined;
    }
    const value: unknown =
      record && typeof record === 'object'
        ? Reflect.get(record, 'value')
        : undefined;
    const expiresAt: unknown =
      record && typeof record === 'object' ? Reflect.get(record, 'e') : 0;
    const staleUntil: unknown =
      record && typeof record === 'object' ? Reflect.get(record, 's') : 0;
    const tags: unknown =
      record && typeof record === 'object' ? Reflect.get(record, 't') : [];
    const epochs: unknown =
      record && typeof record === 'object' ? Reflect.get(record, 'g') : [];
    if (
      !record ||
      Reflect.get(record, 'v') !== 1 ||
      value === undefined ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(staleUntil) ||
      !Array.isArray(tags) ||
      !tags.every((tag) => typeof tag === 'string' && tagPattern.test(tag)) ||
      !Array.isArray(epochs) ||
      epochs.length !== tags.length
    ) {
      // A corrupt entry reads as a miss and is removed.
      await this.delete(key);
      return undefined;
    }
    if ((staleUntil as number) <= this.#now()) return undefined;
    // An invalidation on any instance bumps the counters before deleting.
    const current = await this.#epochs(tags as string[]);
    if (current.some((epoch, index) => epoch !== epochs[index])) {
      await this.delete(key);
      return undefined;
    }
    return {
      value: value as T,
      expiresAt: expiresAt as number,
      staleUntil: staleUntil as number,
      tags: Object.freeze([...(tags as string[])]),
    };
  }

  /** Opaque invalidation state of `tags`, checked again by `set`. */
  async tagMarker(tags: readonly string[]): Promise<string> {
    return JSON.stringify(await this.#epochs(this.#tags(tags)));
  }

  async set<T>(
    key: string,
    entry: CacheEntry<T>,
    marker?: string,
  ): Promise<boolean> {
    const id = this.#id(key);
    const tags = this.#tags(entry.tags);
    if (
      !Number.isSafeInteger(entry.expiresAt) ||
      !Number.isSafeInteger(entry.staleUntil) ||
      entry.staleUntil < entry.expiresAt
    )
      invalid('invalid entry times');
    if (marker !== undefined && typeof marker !== 'string')
      invalid('invalid marker');
    refuseSigned(entry.value);
    const valueText = JSON.stringify(entry.value);
    if (typeof valueText !== 'string') invalid('values must be JSON data');
    // Tags, times and counters add at most ~9 KiB to the value.
    if (Buffer.byteLength(valueText) + 9216 > this.#maxEntryBytes)
      throw new Error('Redis cache store: entry exceeds maxEntryBytes');
    const ttlMs = entry.staleUntil - this.#now();
    if (ttlMs <= 0) return true;
    const epochKeys = tags.map((tag) => this.#epochKey(tag));
    const written = await this.#atomic(epochKeys, async (run) => {
      const epochs = await Promise.all(
        epochKeys.map(async (name) => epochOf(await run('GET', name))),
      );
      if (marker !== undefined && JSON.stringify(epochs) !== marker)
        return null;
      const record = `{"v":1,"value":${valueText},"e":${entry.expiresAt},"s":${entry.staleUntil},"t":${JSON.stringify(tags)},"g":${JSON.stringify(epochs)}}`;
      return [
        ['SET', this.#entryKey(id), record, 'PX', String(ttlMs)],
        ['ZADD', this.#indexKey(), String(entry.staleUntil), id],
        ...tags.flatMap((tag) => [
          ['SADD', this.#tagKey(tag), id],
          ['PEXPIRE', this.#tagKey(tag), String(tagIndexTtlMs)],
        ]),
        ...(tags.length ? [['SADD', this.#tagsKey(), ...tags]] : []),
      ];
    });
    if (!written) return false;
    await this.#evict();
    return true;
  }

  /** Keep the index within `maxEntries`: expired entries first, then those closest to expiry. */
  async #evict(): Promise<void> {
    const index = this.#indexKey();
    let size = Number(await this.#command('ZCARD', index));
    if (size <= this.#maxEntries) return;
    const expired = await this.#command(
      'ZRANGEBYSCORE',
      index,
      '-inf',
      String(this.#now()),
      'LIMIT',
      '0',
      String(batch),
    );
    if (Array.isArray(expired) && expired.length) {
      const ids = expired.filter((id) => typeof id === 'string');
      await this.#command('ZREM', index, ...ids);
      size -= ids.length;
    }
    const excess = Math.min(size - this.#maxEntries, batch);
    if (excess <= 0) return;
    const victims = await this.#command(
      'ZRANGEBYSCORE',
      index,
      '-inf',
      '+inf',
      'LIMIT',
      '0',
      String(excess),
    );
    if (!Array.isArray(victims) || !victims.length) return;
    const ids = victims.filter((id) => typeof id === 'string');
    await this.#command('DEL', ...ids.map((id) => this.#entryKey(id)));
    await this.#command('ZREM', index, ...ids);
  }

  async delete(key: string): Promise<void> {
    const id = this.#id(key);
    await this.#command('DEL', this.#entryKey(id));
    await this.#command('ZREM', this.#indexKey(), id);
  }

  async invalidateTags(tags: readonly string[]): Promise<number> {
    const unique = this.#tags(tags);
    let removed = 0;
    for (const tag of unique) {
      // Counter first: from here no instance serves an entry with this tag.
      await this.#command('INCR', this.#epochKey(tag));
      await this.#command('PEXPIRE', this.#epochKey(tag), String(epochTtlMs));
      const members = await this.#command('SMEMBERS', this.#tagKey(tag));
      const ids = Array.isArray(members)
        ? members.filter((id) => typeof id === 'string')
        : [];
      for (let offset = 0; offset < ids.length; offset += batch) {
        const chunk = ids.slice(offset, offset + batch);
        removed += Number(
          await this.#command('DEL', ...chunk.map((id) => this.#entryKey(id))),
        );
        await this.#command('ZREM', this.#indexKey(), ...chunk);
      }
      await this.#command('DEL', this.#tagKey(tag));
    }
    return removed;
  }

  /** Remove every entry and tag index of this prefix and invalidate every known tag. */
  async clear(): Promise<void> {
    const index = this.#indexKey();
    for (;;) {
      const ids = await this.#command(
        'ZRANGEBYSCORE',
        index,
        '-inf',
        '+inf',
        'LIMIT',
        '0',
        String(batch),
      );
      if (!Array.isArray(ids) || !ids.length) break;
      const chunk = ids.filter((id) => typeof id === 'string');
      await this.#command('DEL', ...chunk.map((id) => this.#entryKey(id)));
      await this.#command('ZREM', index, ...chunk);
    }
    const tags = await this.#command('SMEMBERS', this.#tagsKey());
    if (Array.isArray(tags) && tags.length)
      await this.invalidateTags(
        tags.filter(
          (tag): tag is string => typeof tag === 'string' && tagPattern.test(tag),
        ),
      );
    await this.#command('DEL', this.#tagsKey());
  }

  /** Cross-process computation lease (`SET NX PX`); `null` while another holder has it. */
  async lock(key: string, ttlMs: number): Promise<CacheLock | null> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000)
      invalid('invalid lock TTL');
    const name = this.#lockKey(this.#id(key));
    const owner = randomBytes(16).toString('base64url');
    const reply = await this.#command(
      'SET',
      name,
      owner,
      'NX',
      'PX',
      String(ttlMs),
    );
    if (reply !== 'OK') return null;
    return {
      // Compare-and-delete: a lapsed lease taken by another holder stays.
      release: async () => {
        await this.#atomic([name], async (run) =>
          (await run('GET', name)) === owner ? [['DEL', name]] : null,
        );
      },
    };
  }

  /** Close connections; entries stay in Redis for the other instances. */
  async close(): Promise<void> {
    await Promise.all([this.#commands.close(), this.#transactions.close()]);
  }
}
