import { describe, expect, it } from 'vitest';
import {
  Cache,
  MemoryCacheStore,
  cacheKey,
  tagChannel,
} from '../packages/cache/dist/index.js';

const alice = 'tenant-a/session/alice';
const bob = 'tenant-a/session/bob-xx';

describe('cache keys', () => {
  it('separate private identities and tenants and ignore vary ordering', () => {
    const base = { namespace: 'render:board', vary: { locale: 'en', rev: 3 } };
    const a = cacheKey({ ...base, scope: { kind: 'private', binding: alice } });
    const b = cacheKey({ ...base, scope: { kind: 'private', binding: bob } });
    const t = cacheKey({
      ...base,
      scope: { kind: 'private', binding: alice, tenant: 'tenant-b' },
    });
    expect(new Set([a, b, t]).size).toBe(3);
    expect(a).not.toContain(alice);
    expect(
      cacheKey({
        namespace: 'render:board',
        vary: { rev: 3, locale: 'en' },
        scope: { kind: 'private', binding: alice },
      }),
    ).toBe(a);
    expect(cacheKey({ ...base, scope: { kind: 'public' } })).toContain(
      '|public|',
    );
    expect(() =>
      cacheKey({ namespace: 'Bad', scope: { kind: 'public' } }),
    ).toThrow();
    expect(() =>
      cacheKey({
        namespace: 'x',
        scope: { kind: 'private', binding: 'short' },
      }),
    ).toThrow(/identity binding/);
    expect(() =>
      cacheKey({
        namespace: 'x',
        scope: { kind: 'public' },
        vary: { 'bad name': 1 },
      }),
    ).toThrow();
  });
});

describe('read-through cache', () => {
  it('caches, coalesces concurrent misses, expires and isolates mutation', async () => {
    let now = 0;
    const cache = new Cache(new MemoryCacheStore(10, () => now), () => now);
    let calls = 0;
    const compute = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rows: [1, 2] };
    };
    const parts = {
      namespace: 'data:orders',
      scope: { kind: 'public' as const },
    };
    const [first, second] = await Promise.all([
      cache.get(parts, { ttlMs: 1000 }, compute),
      cache.get(parts, { ttlMs: 1000 }, compute),
    ]);
    expect(calls).toBe(1);
    expect(cache.metrics.coalesced).toBe(1);
    first.rows.push(99);
    expect(second.rows).toEqual([1, 2]);
    expect(await cache.get(parts, { ttlMs: 1000 }, compute)).toEqual({
      rows: [1, 2],
    });
    expect(cache.metrics.hits).toBe(1);
    now = 1001;
    await cache.get(parts, { ttlMs: 1000 }, compute);
    expect(calls).toBe(2);
  });

  it('serves stale public values while refreshing once, and refuses SWR for private data', async () => {
    let now = 0;
    const cache = new Cache(new MemoryCacheStore(10, () => now), () => now);
    let version = 1;
    const parts = {
      namespace: 'render:landing',
      scope: { kind: 'public' as const },
    };
    await cache.get(
      parts,
      { ttlMs: 100, staleWhileRevalidateMs: 1000 },
      () => version,
    );
    version = 2;
    now = 150;
    expect(
      await cache.get(
        parts,
        { ttlMs: 100, staleWhileRevalidateMs: 1000 },
        () => version,
      ),
    ).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await cache.get(
        parts,
        { ttlMs: 100, staleWhileRevalidateMs: 1000 },
        () => 3,
      ),
    ).toBe(2);
    await expect(
      cache.get(
        {
          namespace: 'render:inbox',
          scope: { kind: 'private', binding: alice },
        },
        { ttlMs: 100, staleWhileRevalidateMs: 10 },
        () => 1,
      ),
    ).rejects.toThrow(/only allowed for public/);
  });

  it('invalidates by tag, notifies dependents and evicts least recently used entries', async () => {
    const notified: string[][] = [];
    const store = new MemoryCacheStore(2);
    const cache = new Cache(store, Date.now, (tags) => {
      notified.push([...tags]);
    });
    const key = (namespace: string) => ({
      namespace,
      scope: { kind: 'public' as const },
    });
    await cache.get(key('a'), { ttlMs: 1000, tags: ['orders:t1'] }, () => 'a');
    await cache.get(key('b'), { ttlMs: 1000, tags: ['orders:t2'] }, () => 'b');
    expect(await cache.invalidate(['orders:t1'])).toBe(1);
    expect(notified).toEqual([['orders:t1']]);
    await cache.get(key('c'), { ttlMs: 1000 }, () => 'c');
    await cache.get(key('d'), { ttlMs: 1000 }, () => 'd');
    expect(store.size).toBe(2);
    let recomputed = false;
    await cache.get(key('b'), { ttlMs: 1000 }, () => {
      recomputed = true;
      return 'b2';
    });
    expect(recomputed).toBe(true);
    await expect(
      cache.get(key('e'), { ttlMs: 1000 }, () => undefined),
    ).rejects.toThrow(/JSON/);
    await expect(cache.invalidate(['Bad Tag'])).rejects.toThrow();
    expect(tagChannel('orders:t1')).toBe('tag:orders:t1');
  });
});
