import { afterEach, describe, expect, it } from 'vitest';
import {
  Cache,
  CacheRefusedError,
  MemoryCacheStore,
  cacheKey,
} from '../packages/cache/dist/index.js';
import type {
  CacheEvent,
  CacheKeyParts,
} from '../packages/cache/dist/index.js';
import { RedisCacheStore } from '../packages/realtime-redis/dist/cache.js';
import { RespConnection } from '../packages/realtime-redis/dist/index.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function server(): Promise<RespDouble> {
  const double = await respDouble();
  cleanup.push(() => double.close());
  return double;
}
function store(
  double: RespDouble,
  options: ConstructorParameters<typeof RedisCacheStore>[0] = {},
): RedisCacheStore {
  const instance = new RedisCacheStore({
    port: double.port,
    prefix: 'test:cache:',
    ...options,
  });
  cleanup.push(() => instance.close());
  return instance;
}
const products: CacheKeyParts = {
  namespace: 'data:products',
  scope: { kind: 'tenant', tenant: 'tenant-a' },
};
const entry = (value: unknown, tags: string[] = [], ttlMs = 60_000) => {
  const now = Date.now();
  return { value, expiresAt: now + ttlMs, staleUntil: now + ttlMs, tags };
};
/** Two `Cache` instances (two app instances) over one Redis. */
function pair(
  double: RespDouble,
  config: { readonly lock?: { ttlMs?: number; waitMs?: number } | false } = {},
) {
  const events: { a: CacheEvent[]; b: CacheEvent[] } = { a: [], b: [] };
  const a = new Cache({
    store: store(double),
    onEvent: (event) => events.a.push(event),
    ...config,
  });
  const b = new Cache({
    store: store(double),
    onEvent: (event) => events.b.push(event),
    ...config,
  });
  return { a, b, events };
}

describe('RedisCacheStore', () => {
  it('round-trips entries, hashes keys and lets Redis expire them', async () => {
    const double = await server();
    const cache = store(double);
    const key = cacheKey({
      namespace: 'data:orders',
      scope: { kind: 'private', binding: 'binding-alice-secret', tenant: 't' },
    });
    expect(await cache.get(key)).toBeUndefined();
    expect(await cache.set(key, entry({ total: 3 }, ['orders:t'], 300))).toBe(
      true,
    );
    expect(await cache.get(key)).toMatchObject({
      value: { total: 3 },
      tags: ['orders:t'],
    });
    for (const name of double.values.keys()) {
      expect(name).not.toContain(key);
      expect(name).not.toContain('binding-alice-secret');
    }
    await sleep(400);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('makes an invalidation on one instance visible on every instance', async () => {
    const double = await server();
    const { a, b } = pair(double);
    let computed = 0;
    const load = () => ({ list: ['p1'], run: ++computed });
    expect(
      (await a.lookup(products, { ttlMs: 60_000, tags: ['products:a'] }, load))
        .status,
    ).toBe('miss');
    const hit = await b.lookup(
      products,
      { ttlMs: 60_000, tags: ['products:a'] },
      load,
    );
    expect(hit).toEqual({ value: { list: ['p1'], run: 1 }, status: 'hit' });
    expect(await b.invalidate(['products:a'])).toBe(1);
    const after = await a.lookup(
      products,
      { ttlMs: 60_000, tags: ['products:a'] },
      load,
    );
    expect(after).toEqual({ value: { list: ['p1'], run: 2 }, status: 'miss' });
  });

  it('hides tagged entries as soon as the invalidation counter moves', async () => {
    const double = await server();
    const cache = store(double);
    await cache.set('k', entry('v', ['orders:x']));
    // An invalidation that bumped the counter but failed before deleting.
    const raw = new RespConnection({ port: double.port });
    cleanup.push(() => raw.close());
    await raw.command('INCR', 'test:cache:g:orders:x');
    expect(await cache.get('k')).toBeUndefined();
  });

  it('discards a value whose computation overlapped an invalidation on another instance', async () => {
    const double = await server();
    const { a, b, events } = pair(double);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = a.lookup(
      products,
      { ttlMs: 60_000, tags: ['products:a'] },
      async () => {
        started();
        await gate;
        return { stale: true };
      },
    );
    await entered;
    await b.invalidate(['products:a']);
    release();
    expect((await pending).value).toEqual({ stale: true });
    expect(a.metrics.discarded).toBe(1);
    expect(events.a.map((event) => event.type)).toContain('discarded');
    const fresh = await b.lookup(
      products,
      { ttlMs: 60_000, tags: ['products:a'] },
      () => ({ stale: false }),
    );
    expect(fresh).toEqual({ value: { stale: false }, status: 'miss' });
  });

  it('computes a key once across instances with the Redis lock', async () => {
    const double = await server();
    const { a, b } = pair(double);
    let computed = 0;
    const slow = async () => {
      computed++;
      await sleep(150);
      return { n: computed };
    };
    const [first, second] = await Promise.all([
      a.lookup(products, { ttlMs: 60_000 }, slow),
      (async () => {
        await sleep(20);
        return b.lookup(products, { ttlMs: 60_000 }, slow);
      })(),
    ]);
    expect(computed).toBe(1);
    expect(first).toEqual({ value: { n: 1 }, status: 'miss' });
    expect(second).toEqual({ value: { n: 1 }, status: 'coalesced' });
    expect(b.metrics.coalesced).toBe(1);
  });

  it('takes over when the lock holder fails, and computes after waitMs', async () => {
    const double = await server();
    const { a, b } = pair(double, { lock: { ttlMs: 5000, waitMs: 2000 } });
    const failing = a.lookup(products, { ttlMs: 60_000 }, async () => {
      await sleep(100);
      throw new Error('database down');
    });
    await sleep(20);
    const waiting = b.lookup(products, { ttlMs: 60_000 }, () => ({ b: true }));
    await expect(failing).rejects.toThrow('database down');
    expect(await waiting).toEqual({ value: { b: true }, status: 'miss' });

    // A holder that never stores: the waiter computes after waitMs.
    const other: CacheKeyParts = {
      namespace: 'data:other',
      scope: { kind: 'public' },
    };
    const short = new Cache({
      store: store(double),
      lock: { ttlMs: 5000, waitMs: 200 },
    });
    const blocker = store(double);
    const held = await blocker.lock(cacheKey(other), 5000);
    expect(held).not.toBeNull();
    expect(await blocker.lock(cacheKey(other), 5000)).toBeNull();
    const at = Date.now();
    expect((await short.lookup(other, { ttlMs: 60_000 }, () => 1)).status).toBe(
      'miss',
    );
    expect(Date.now() - at).toBeGreaterThanOrEqual(180);
    await held?.release();
    expect(await blocker.lock(cacheKey(other), 5000)).not.toBeNull();
  });

  it('keeps stampede protection per process with lock: false (documented)', async () => {
    const double = await server();
    const { a, b } = pair(double, { lock: false });
    let computed = 0;
    const slow = async () => {
      computed++;
      await sleep(100);
      return computed;
    };
    await Promise.all([
      a.lookup(products, { ttlMs: 60_000 }, slow),
      a.lookup(products, { ttlMs: 60_000 }, slow),
      b.lookup(products, { ttlMs: 60_000 }, slow),
    ]);
    // One computation per instance: A coalesced its two misses, B computed.
    expect(computed).toBe(2);
  });

  it('never stores Live snapshots, CSRF tokens or signed island props', async () => {
    const double = await server();
    const cache = store(double);
    const snapshot = {
      snapshot: 'a'.repeat(43),
      revision: 1,
    };
    for (const value of [
      '<div data-nv-snapshot="x"></div>',
      '<input name="_csrf" value="t">',
      '<nv-island data-nv-props-token="sig"></nv-island>',
      snapshot,
      // The JSON text form `Cache` writes.
      JSON.stringify({ nested: snapshot }),
    ])
      await expect(cache.set('refused', entry(value))).rejects.toBeInstanceOf(
        CacheRefusedError,
      );
    expect([...double.values.keys()]).toEqual([]);
    const front = new Cache({ store: cache });
    await expect(
      front.get(products, { ttlMs: 60_000 }, () => ({
        html: '<form><input name="csrf-token" value="x"></form>',
      })),
    ).rejects.toBeInstanceOf(CacheRefusedError);
    expect([...double.values.keys()].some((name) => name.includes(':e:'))).toBe(
      false,
    );
  });

  it('bounds entry size and the number of indexed entries', async () => {
    const double = await server();
    const small = store(double, { maxEntryBytes: 10_240 });
    await expect(small.set('big', entry('x'.repeat(2000)))).rejects.toThrow(
      'entry exceeds maxEntryBytes',
    );
    const events: CacheEvent[] = [];
    const front = new Cache({ store: small, onEvent: (e) => events.push(e) });
    expect(
      await front.get(products, { ttlMs: 60_000 }, () => 'y'.repeat(2000)),
    ).toHaveLength(2000);
    expect(events.map((event) => event.reason)).toContain('set');

    const bounded = store(double, { prefix: 'test:bounded:', maxEntries: 3 });
    for (let index = 0; index < 5; index++)
      await bounded.set(`k${index}`, entry(index, [], 10_000 + index * 1000));
    const index = double.values.get('test:bounded:i');
    expect(index instanceof Map ? index.size : -1).toBe(3);
    // The entries closest to expiry were evicted.
    expect(await bounded.get('k0')).toBeUndefined();
    expect(await bounded.get('k1')).toBeUndefined();
    expect((await bounded.get('k4'))?.value).toBe(4);
  });

  it('treats corrupt entries as misses and removes them', async () => {
    const double = await server();
    const cache = store(double);
    await cache.set('k', entry('v'));
    const name = [...double.values.keys()].find((key) => key.includes(':e:'));
    expect(name).toBeDefined();
    double.values.set(name ?? '', '{"v":2}');
    expect(await cache.get('k')).toBeUndefined();
    expect(double.values.has(name ?? '')).toBe(false);
  });

  it('degrades reads to computing when Redis is down and fails invalidation loudly', async () => {
    const double = await server();
    const cache = new Cache({
      store: store(double, { circuitBreaker: false, commandTimeoutMs: 500 }),
    });
    await double.close();
    expect(await cache.get(products, { ttlMs: 60_000 }, () => 42)).toBe(42);
    expect(cache.metrics.errors).toBeGreaterThan(0);
    await expect(cache.invalidate(['products:a'])).rejects.toThrow(
      'Cache store is unavailable',
    );
  });

  it('clears every entry and tag of its prefix only', async () => {
    const double = await server();
    const a = store(double);
    const other = store(double, { prefix: 'test:other:' });
    await a.set('k1', entry(1, ['t1']));
    await a.set('k2', entry(2, ['t2']));
    await other.set('k1', entry('kept'));
    await a.clear();
    expect(await a.get('k1')).toBeUndefined();
    expect(await a.get('k2')).toBeUndefined();
    expect((await other.get('k1'))?.value).toBe('kept');
  });

  it('validates options, tags and entries', async () => {
    const double = await server();
    const cache = store(double);
    expect(() => new RedisCacheStore({ prefix: 'UPPER' })).toThrow(
      'invalid prefix',
    );
    expect(() => new RedisCacheStore({ maxEntries: 0 })).toThrow(
      'invalid maxEntries',
    );
    expect(() => new RedisCacheStore({ maxEntryBytes: 1 })).toThrow(
      'invalid maxEntryBytes',
    );
    await expect(cache.set('k', entry('v', ['Bad Tag']))).rejects.toThrow(
      'invalid tag',
    );
    await expect(cache.invalidateTags(['../x'])).rejects.toThrow('invalid tag');
    await expect(cache.lock('k', 0)).rejects.toThrow('invalid lock TTL');
    expect(() => new Cache({ lock: { ttlMs: 1 } })).toThrow(
      'Cache lock ttlMs must be 100 ms to 5 minutes',
    );
    expect(() => new Cache({ lock: { waitMs: -1 } })).toThrow(
      'Cache lock waitMs must be 0 ms to 1 minute',
    );
  });

  it('leaves the memory store per process: no lock, no marker', () => {
    const memory = new MemoryCacheStore();
    expect('lock' in memory).toBe(false);
    expect('tagMarker' in memory).toBe(false);
  });
});
