import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Cache,
  CacheRefusedError,
  MemoryCacheStore,
  RenderCache,
  cacheKey,
  cacheableJson,
  renderCacheKey,
} from '../packages/cache/dist/index.js';
import type {
  CacheEntry,
  CacheEvent,
  CacheStore,
  RenderCacheRequest,
} from '../packages/cache/dist/index.js';

// DATA-006 / DATA-007 / DATA-008: render/data cache keys, private-HTML
// default, tags, stale-while-revalidate, telemetry, stampede protection and
// refusal of signed per-user material. The example application is covered by
// tests/cache-example.test.ts.

const alice = 'tenant-a/session-alice/principal-alice';
const bob = 'tenant-a/session-bob/principal-bob';
const base: RenderCacheRequest = {
  component: 'catalog',
  revision: 'v1',
  renderer: 'hbs',
  locale: 'en',
  tenant: 'tenant-a',
  permissions: ['products:read'],
  assetVersion: 'abc123',
  audience: 'tenant',
  ttlMs: 60_000,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('render cache keys (DATA-006)', () => {
  it('change with every field the output depends on and ignore permission order', () => {
    const fields = fc.record({
      component: fc.constantFrom('catalog', 'board', 'nav.menu'),
      revision: fc.oneof(
        fc.integer({ min: 0, max: 5 }),
        fc.constantFrom('v1', 'v2'),
      ),
      renderer: fc.constantFrom('hbs', 'ejs', 'inertia-ssr'),
      locale: fc.constantFrom('en', 'ar', 'en-GB'),
      tenant: fc.constantFrom('tenant-a', 'tenant-b'),
      permissions: fc.uniqueArray(
        fc.constantFrom('products:read', 'products:write', 'admin'),
      ),
      assetVersion: fc.constantFrom('a1', 'b2'),
      page: fc.integer({ min: 1, max: 3 }),
    });
    type Fields = {
      component: string;
      revision: string | number;
      renderer: string;
      locale: string;
      tenant: string;
      permissions: string[];
      assetVersion: string;
      page: number;
    };
    const request = (value: Fields): RenderCacheRequest => ({
      ...base,
      component: value.component,
      revision: value.revision,
      renderer: value.renderer,
      locale: value.locale,
      tenant: value.tenant,
      permissions: value.permissions,
      assetVersion: value.assetVersion,
      vary: { page: value.page },
    });
    fc.assert(
      fc.property(fields, fields, (left, right) => {
        const same =
          left.component === right.component &&
          left.revision === right.revision &&
          left.renderer === right.renderer &&
          left.locale === right.locale &&
          left.tenant === right.tenant &&
          [...left.permissions].sort().join() ===
            [...right.permissions].sort().join() &&
          left.assetVersion === right.assetVersion &&
          left.page === right.page;
        const a = renderCacheKey(request(left));
        const b = renderCacheKey(request(right));
        return same ? a === b : a !== b;
      }),
      { numRuns: 400 },
    );
    expect(
      renderCacheKey({ ...base, permissions: ['b:x', 'a:y', 'a:y'] }),
    ).toBe(renderCacheKey({ ...base, permissions: ['a:y', 'b:x'] }));
    expect(renderCacheKey({ ...base, locale: 'en-GB' })).toBe(
      renderCacheKey({ ...base, locale: 'en-gb' }),
    );
    // A numeric and a textual revision never collide.
    expect(renderCacheKey({ ...base, revision: 1 })).not.toBe(
      renderCacheKey({ ...base, revision: '1' }),
    );
    // Audience is part of the key: tenant-shared and public never collide.
    expect(renderCacheKey({ ...base, audience: 'public' })).not.toBe(
      renderCacheKey(base),
    );
  });

  it('requires every context field and validates it', () => {
    const broken: [string, Record<string, unknown>][] = [
      ['component', { component: 'Bad Name' }],
      ['component', { component: undefined }],
      ['revision', { revision: undefined }],
      ['revision', { revision: 1.5 }],
      ['renderer', { renderer: undefined }],
      ['locale', { locale: 'en_US' }],
      ['locale', { locale: undefined }],
      ['tenant', { tenant: undefined }],
      ['tenant', { tenant: 'Tenant A' }],
      ['permissions', { permissions: undefined }],
      ['permissions', { permissions: ['bad permission'] }],
      ['assetVersion', { assetVersion: undefined }],
      ['tenant', { tenant: null }],
      ['binding', { audience: 'private', binding: undefined }],
      ['audience', { audience: 'everyone' }],
    ];
    for (const [field, change] of broken)
      expect(
        () =>
          renderCacheKey({
            ...base,
            ...change,
          } as unknown as RenderCacheRequest),
        field,
      ).toThrow(new RegExp(`Invalid render cache ${field}`));
    expect(() =>
      cacheKey({
        namespace: 'data:x',
        scope: { kind: 'public' },
        vary: { value: Number.NaN },
      }),
    ).toThrow(/vary value/);
    expect(() =>
      cacheKey({
        namespace: 'data:x',
        scope: { kind: 'tenant', tenant: 'Bad Tenant' },
      }),
    ).toThrow(/tenant/);
  });
});

describe('render cache privacy (DATA-006, DATA-008)', () => {
  it('never stores private per-user HTML by default', async () => {
    const store = new MemoryCacheStore();
    const events: CacheEvent[] = [];
    const renders = new RenderCache(
      new Cache({ store, onEvent: (event) => events.push(event) }),
    );
    let calls = 0;
    const request: RenderCacheRequest = {
      ...base,
      component: 'inbox',
      audience: 'private',
      binding: alice,
    };
    for (let index = 0; index < 3; index++)
      expect(await renders.render(request, () => `<p>${++calls}</p>`)).toEqual(
        { html: `<p>${index + 1}</p>`, status: 'bypass' },
      );
    expect(calls).toBe(3);
    expect(store.size).toBe(0);
    expect(renders.cache.metrics.bypassed).toBe(3);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: 'bypass',
      namespace: 'render:inbox',
      scope: 'private',
      reason: 'private-html',
    });
  });

  it('with cachePrivate, isolates users and tenants, never coalesces across them and refuses SWR', async () => {
    const renders = new RenderCache(new Cache(), { cachePrivate: true });
    const computed: string[] = [];
    const render = (who: string) => async () => {
      computed.push(who);
      await tick();
      return `<p>${who}</p>`;
    };
    const mine = { ...base, component: 'inbox', audience: 'private' as const };
    const results = await Promise.all([
      renders.render({ ...mine, binding: alice }, render('alice')),
      renders.render({ ...mine, binding: bob }, render('bob')),
      renders.render(
        { ...mine, binding: alice, tenant: 'tenant-b' },
        render('alice@b'),
      ),
      renders.render({ ...mine, binding: alice }, render('alice-again')),
    ]);
    expect(results.map((result) => result.html)).toEqual([
      '<p>alice</p>',
      '<p>bob</p>',
      '<p>alice@b</p>',
      '<p>alice</p>',
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'miss',
      'miss',
      'miss',
      'coalesced',
    ]);
    expect(computed).toEqual(['alice', 'bob', 'alice@b']);
    expect(
      (await renders.render({ ...mine, binding: bob }, render('bob-2'))).html,
    ).toBe('<p>bob</p>');
    await expect(
      renders.render(
        { ...mine, binding: alice, staleWhileRevalidateMs: 1000 },
        render('x'),
      ),
    ).rejects.toThrow(/only allowed for public or tenant/);
  });

  it('shares tenant HTML only within a tenant, permission scope, locale and asset version', async () => {
    const renders = new RenderCache();
    let calls = 0;
    const render = () => `<ul>${++calls}</ul>`;
    expect((await renders.render(base, render)).status).toBe('miss');
    expect(await renders.render(base, render)).toEqual({
      html: '<ul>1</ul>',
      status: 'hit',
    });
    expect(await renders.render({ ...base, tenant: 'tenant-b' }, render)).toEqual(
      { html: '<ul>2</ul>', status: 'miss' },
    );
    expect(
      await renders.render(
        { ...base, permissions: ['products:read', 'products:write'] },
        render,
      ),
    ).toEqual({ html: '<ul>3</ul>', status: 'miss' });
    expect((await renders.render({ ...base, locale: 'ar' }, render)).status).toBe(
      'miss',
    );
    expect(
      (await renders.render({ ...base, assetVersion: 'def456' }, render)).status,
    ).toBe('miss');
    expect(calls).toBe(5);
  });

  it('refuses HTML or data carrying Live snapshots, CSRF tokens or signed props, for every waiter', async () => {
    const store = new MemoryCacheStore();
    const renders = new RenderCache(new Cache(store), { cachePrivate: true });
    const token = 'A'.repeat(43);
    const hostile = [
      `<div data-nv-live="cart" data-nv-snapshot="${token}"></div>`,
      `<div data-nv-csrf="${'c'.repeat(43)}"></div>`,
      '<div data-nv-island="chart" data-nv-props-token="v1.1.2.x"></div>',
      '<form><input type="hidden" name="_csrf" value="t"></form>',
      '<meta name="csrf-token" content="t">',
    ];
    for (const html of hostile)
      for (const audience of ['public', 'tenant', 'private'] as const) {
        const request = {
          ...base,
          audience,
          binding: alice,
          component: `x-${audience}`,
        };
        const [first, waiter] = await Promise.allSettled([
          renders.render(request, async () => {
            await tick();
            return html;
          }),
          renders.render(request, () => '<p>never</p>'),
        ]);
        expect(first.status).toBe('rejected');
        expect(waiter.status).toBe('rejected');
        if (first.status === 'rejected')
          expect(first.reason).toBeInstanceOf(CacheRefusedError);
        if (waiter.status === 'rejected')
          expect(waiter.reason).toBeInstanceOf(CacheRefusedError);
      }
    expect(store.size).toBe(0);
    expect(renders.cache.metrics.refused).toBe(hostile.length * 3);
    // Data caching refuses Live StateSnapshot-shaped objects anywhere in the value.
    const data = new Cache();
    await expect(
      data.get(
        { namespace: 'data:x', scope: { kind: 'public' } },
        { ttlMs: 1000 },
        () => ({ rows: [{ snapshot: token, revision: 3, state: {} }] }),
      ),
    ).rejects.toBeInstanceOf(CacheRefusedError);
    expect(() =>
      cacheableJson({ snapshot: 'short', revision: 1 }),
    ).not.toThrow();
    expect(() => cacheableJson(undefined)).toThrow(/JSON/);
  });
});

describe('tags, stale-while-revalidate and stampede protection (DATA-007)', () => {
  it('invalidates by tag across permission scopes and discards computations that overlap an invalidation', async () => {
    const renders = new RenderCache();
    const tags = ['products:tenant-a'];
    await renders.render({ ...base, tags }, () => '<ul>old</ul>');
    await renders.render(
      { ...base, tags, permissions: ['products:write'] },
      () => '<ul>old-admin</ul>',
    );
    expect(await renders.invalidate(tags)).toBe(2);
    // A render that read data before a write finishes after the invalidation.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = renders.render({ ...base, tags }, async () => {
      await gate;
      return '<ul>read-before-write</ul>';
    });
    await tick();
    await renders.invalidate(tags);
    release();
    expect((await slow).html).toBe('<ul>read-before-write</ul>');
    expect(renders.cache.metrics.discarded).toBe(1);
    expect(await renders.render({ ...base, tags }, () => '<ul>new</ul>')).toEqual(
      { html: '<ul>new</ul>', status: 'miss' },
    );
  });

  it('serves stale tenant HTML while one refresh runs, and keeps serving it when the refresh fails', async () => {
    let now = 0;
    const events: CacheEvent[] = [];
    const cache = new Cache({
      store: new MemoryCacheStore(10, () => now),
      now: () => now,
      onEvent: (event) => events.push(event),
    });
    const renders = new RenderCache(cache);
    const request = { ...base, ttlMs: 100, staleWhileRevalidateMs: 1000 };
    await renders.render(request, () => '<p>1</p>');
    now = 150;
    let refreshes = 0;
    const failing = async () => {
      refreshes++;
      await tick();
      throw new Error('database down');
    };
    const stale = await Promise.all([
      renders.render(request, failing),
      renders.render(request, failing),
      renders.render(request, failing),
    ]);
    expect(stale.map((result) => result.status)).toEqual([
      'stale',
      'stale',
      'stale',
    ]);
    expect(stale.every((result) => result.html === '<p>1</p>')).toBe(true);
    await tick();
    await tick();
    expect(refreshes).toBe(1);
    expect(events.some((event) => event.type === 'refresh-error')).toBe(true);
    expect((await renders.render(request, () => '<p>2</p>')).status).toBe(
      'stale',
    );
    await tick();
    expect((await renders.render(request, () => '<p>3</p>')).html).toBe(
      '<p>2</p>',
    );
    // Beyond the stale window the value is gone.
    now = 5000;
    expect((await renders.render(request, () => '<p>4</p>')).status).toBe(
      'miss',
    );
  });

  it('coalesces a stampede of 50 concurrent misses into one computation', async () => {
    const renders = new RenderCache();
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        renders.render(base, async () => {
          calls++;
          await tick();
          return '<p>once</p>';
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(
      results.filter((result) => result.status === 'coalesced'),
    ).toHaveLength(49);
    expect(renders.cache.metrics.coalesced).toBe(49);
  });
});

describe('telemetry and store failures (DATA-007)', () => {
  it('reports events and spans without keys, bindings or values; broken hooks never break requests', async () => {
    const events: CacheEvent[] = [];
    const spans: { name: string; attributes: object; outcome?: string }[] = [];
    const cache = new Cache({
      onEvent: (event) => {
        events.push(event);
        throw new Error('broken metrics sink');
      },
      instrumentation: {
        start(name, attributes) {
          const span: { name: string; attributes: object; outcome?: string } =
            { name, attributes };
          spans.push(span);
          return {
            end(outcome) {
              span.outcome = outcome;
            },
          };
        },
      },
    });
    const parts = {
      namespace: 'data:orders',
      scope: { kind: 'private' as const, binding: alice, tenant: 'tenant-a' },
    };
    await cache.get(
      parts,
      { ttlMs: 1000, tags: ['orders:tenant-a'] },
      () => ['secret-row'],
    );
    await cache.get(parts, { ttlMs: 1000 }, () => ['other']);
    await cache.invalidate(['orders:tenant-a']);
    await expect(
      cache.get(parts, { ttlMs: 1000 }, () => {
        throw new Error('query failed');
      }),
    ).rejects.toThrow('query failed');
    expect(events.map((event) => event.type)).toEqual([
      'miss',
      'hit',
      'invalidate',
      'compute-error',
    ]);
    expect(events[0]).toMatchObject({
      namespace: 'data:orders',
      scope: 'private',
    });
    expect(typeof events[0]?.durationMs).toBe('number');
    expect(events[2]).toMatchObject({ tags: ['orders:tenant-a'], removed: 1 });
    const text = JSON.stringify(events) + JSON.stringify(spans);
    expect(text).not.toContain(alice);
    expect(text).not.toContain('secret-row');
    expect(spans.map((span) => [span.name, span.outcome])).toEqual([
      ['nestvexa.cache.compute', 'ok'],
      ['nestvexa.cache.compute', 'error'],
    ]);
    expect(cache.metrics).toMatchObject({
      hits: 1,
      misses: 2,
      errors: 1,
      invalidations: 1,
    });
  });

  it('degrades to computing when an async store fails, and propagates invalidation failures', async () => {
    let healthy = false;
    const entries = new Map<string, CacheEntry<unknown>>();
    const store: CacheStore = {
      async get<T>(key: string) {
        if (!healthy) throw new Error('store down');
        return entries.get(key) as CacheEntry<T> | undefined;
      },
      async set(key, entry) {
        if (!healthy) throw new Error('store down');
        entries.set(key, entry);
      },
      async delete(key) {
        entries.delete(key);
      },
      async invalidateTags() {
        if (!healthy) throw new Error('store down');
        return 0;
      },
      async clear() {
        entries.clear();
      },
    };
    const events: CacheEvent[] = [];
    const cache = new Cache({ store, onEvent: (event) => events.push(event) });
    const parts = { namespace: 'data:x', scope: { kind: 'public' as const } };
    expect(await cache.get(parts, { ttlMs: 1000 }, () => 'computed')).toBe(
      'computed',
    );
    expect(events.filter((event) => event.type === 'store-error')).toEqual([
      {
        type: 'store-error',
        namespace: 'data:x',
        scope: 'public',
        reason: 'get',
      },
      {
        type: 'store-error',
        namespace: 'data:x',
        scope: 'public',
        reason: 'set',
      },
    ]);
    await expect(cache.invalidate(['x'])).rejects.toThrow('store down');
    healthy = true;
    await cache.get(parts, { ttlMs: 1000 }, () => 'stored');
    expect(await cache.lookup(parts, { ttlMs: 1000 }, () => 'unused')).toEqual(
      { value: 'stored', status: 'hit' },
    );
  });

  it('keeps the positional constructor and rejects mixing both forms', async () => {
    let now = 0;
    const notified: string[][] = [];
    const cache = new Cache(
      new MemoryCacheStore(10, () => now),
      () => now,
      (tags) => {
        notified.push([...tags]);
      },
    );
    const parts = { namespace: 'data:x', scope: { kind: 'public' as const } };
    await cache.get(parts, { ttlMs: 10, tags: ['t'] }, () => 1);
    now = 11;
    expect((await cache.lookup(parts, { ttlMs: 10 }, () => 2)).status).toBe(
      'miss',
    );
    await cache.invalidate(['t']);
    expect(notified).toEqual([['t']]);
    expect(() => new Cache({}, () => 0)).toThrow(/inside the Cache options/);
  });
});
