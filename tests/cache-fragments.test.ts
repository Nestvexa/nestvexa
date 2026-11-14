import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Cache,
  CacheRefusedError,
  FragmentCache,
  MemoryCacheStore,
  RenderCache,
} from '../packages/cache/dist/index.js';
import type {
  CacheEvent,
  FragmentRequest,
} from '../packages/cache/dist/index.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { SafeHtml } from '../packages/views/dist/index.js';

// EXT-006: read-only fragment caching for HBS views on top of RenderCache,
// with explicit scope and key inputs and no storage of personal HTML by
// default.

let root: string;
let engine: HbsEngine;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nestvexa-fragments-'));
  await mkdir(path.join(root, 'partials'));
  await mkdir(path.join(root, 'layouts'));
  await writeFile(
    path.join(root, 'partials', 'catalog.hbs'),
    '<ul class="catalog">{{#each products}}<li>{{name}}</li>{{/each}}</ul>{{greeting}}',
  );
  await writeFile(
    path.join(root, 'partials', 'account.hbs'),
    '<p class="account">Signed in as {{user}}</p>',
  );
  await writeFile(
    path.join(root, 'partials', 'live.hbs'),
    '<div data-nv-snapshot="{{token}}"></div>',
  );
  await writeFile(
    path.join(root, 'layouts', 'main.hbs'),
    '<html><body>{{body}}</body></html>',
  );
  await writeFile(
    path.join(root, 'page.hbs'),
    '<main>{{catalog}}<span>{{user}}</span></main>',
  );
  engine = new HbsEngine({ root, defaultLayout: 'layouts/main' });
  await engine.initialize();
});
afterAll(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});

function catalogRequest(
  overrides: Partial<FragmentRequest> = {},
  loads: { count: number } = { count: 0 },
  products: readonly { name: string }[] = [{ name: 'Lamp' }],
): FragmentRequest {
  return {
    key: 'catalog',
    view: 'partials/catalog',
    revision: 'v1',
    audience: 'tenant',
    locale: 'en',
    tenant: 'tenant-a',
    permissions: ['products:read'],
    ttlMs: 60_000,
    tags: ['products:tenant-a'],
    model: () => {
      loads.count++;
      return { products };
    },
    ...overrides,
  };
}

describe('FragmentCache (EXT-006)', () => {
  it('renders a fragment without the layout, stores it and skips the model loader on a hit', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    const loads = { count: 0 };
    const first = await fragments.render(catalogRequest({}, loads));
    expect(first.status).toBe('miss');
    expect(first.html).toBeInstanceOf(SafeHtml);
    expect(first.html.value).toBe('<ul class="catalog"><li>Lamp</li></ul>');
    const second = await fragments.render(catalogRequest({}, loads));
    expect(second.status).toBe('hit');
    expect(second.html.value).toBe(first.html.value);
    expect(loads.count).toBe(1);
  });

  it('embeds as trusted HTML in an HBS page while page values stay escaped', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    const catalog = await fragments.render(
      catalogRequest({}, { count: 0 }, [{ name: '<b>Desk</b>' }]),
    );
    const page = await engine.render('page', {
      catalog: catalog.html,
      user: '<script>x</script>',
    });
    expect(page).toBe(
      '<html><body><main><ul class="catalog"><li>&lt;b&gt;Desk&lt;/b&gt;</li></ul><span>&lt;script&gt;x&lt;/script&gt;</span></main></body></html>',
    );
  });

  it('renders the fragment from its own model only, never the page model', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    const result = await fragments.render(
      catalogRequest({ key: 'catalog.isolated' }),
    );
    // `greeting` exists only in page models; the fragment does not see it.
    expect(result.html.value).not.toContain('greeting');
    expect(result.html.value).toBe('<ul class="catalog"><li>Lamp</li></ul>');
  });

  it('never stores private (personal) fragments by default', async () => {
    const events: CacheEvent[] = [];
    const cache = new Cache({
      store: new MemoryCacheStore(),
      onEvent: (event) => events.push(event),
    });
    const fragments = new FragmentCache({
      engine,
      assetVersion: 'a1',
      renders: new RenderCache(cache),
    });
    let loads = 0;
    const account = (user: string, binding: string): FragmentRequest => ({
      key: 'account',
      view: 'partials/account',
      revision: 1,
      audience: 'private',
      binding,
      locale: 'en',
      tenant: 'tenant-a',
      permissions: [],
      ttlMs: 60_000,
      model: () => {
        loads++;
        return { user };
      },
    });
    const alice = await fragments.render(
      account('alice', 'tenant-a/session-1/alice'),
    );
    const again = await fragments.render(
      account('alice', 'tenant-a/session-1/alice'),
    );
    const bob = await fragments.render(
      account('bob', 'tenant-a/session-2/bob'),
    );
    expect([alice.status, again.status, bob.status]).toEqual([
      'bypass',
      'bypass',
      'bypass',
    ]);
    expect(loads).toBe(3);
    expect(bob.html.value).toBe('<p class="account">Signed in as bob</p>');
    expect(cache.metrics.bypassed).toBe(3);
    expect(events.every((event) => event.type === 'bypass')).toBe(true);
  });

  it('stores private fragments per identity only when the RenderCache opts in', async () => {
    const fragments = new FragmentCache({
      engine,
      assetVersion: 'a1',
      renders: new RenderCache(new Cache(), { cachePrivate: true }),
    });
    const account = (user: string, binding: string): FragmentRequest => ({
      key: 'account',
      view: 'partials/account',
      revision: 1,
      audience: 'private',
      binding,
      locale: 'en',
      tenant: 'tenant-a',
      permissions: [],
      ttlMs: 60_000,
      model: () => ({ user }),
    });
    expect(
      (await fragments.render(account('alice', 'tenant-a/session-1/alice')))
        .status,
    ).toBe('miss');
    const bob = await fragments.render(
      account('bob', 'tenant-a/session-2/bob'),
    );
    expect(bob.status).toBe('miss');
    expect(bob.html.value).toContain('bob');
    expect(
      (await fragments.render(account('alice', 'tenant-a/session-1/alice')))
        .status,
    ).toBe('hit');
    await expect(
      fragments.render({
        ...account('alice', 'tenant-a/session-1/alice'),
        staleWhileRevalidateMs: 1000,
      }),
    ).rejects.toThrow();
  });

  it('keys on every explicit scope input: tenant, permissions, locale, revision, asset version and vary', async () => {
    let version = 'a1';
    const fragments = new FragmentCache({
      engine,
      assetVersion: () => version,
    });
    const loads = { count: 0 };
    await fragments.render(catalogRequest({}, loads));
    const variants: Partial<FragmentRequest>[] = [
      { tenant: 'tenant-b' },
      { permissions: ['products:read', 'products:write'] },
      { locale: 'ar' },
      { revision: 'v2' },
      { vary: { page: 2 } },
      { audience: 'public' },
    ];
    for (const variant of variants)
      expect(
        (await fragments.render(catalogRequest(variant, loads))).status,
      ).toBe('miss');
    version = 'b2';
    expect((await fragments.render(catalogRequest({}, loads))).status).toBe(
      'miss',
    );
    expect(loads.count).toBe(variants.length + 2);
    // Permission order and locale case do not split the key.
    expect(
      (
        await fragments.render(
          catalogRequest(
            { permissions: ['products:write', 'products:read'] },
            loads,
          ),
        )
      ).status,
    ).toBe('miss');
    version = 'a1';
    expect(
      (
        await fragments.render(
          catalogRequest(
            { permissions: ['products:write', 'products:read'] },
            loads,
          ),
        )
      ).status,
    ).toBe('hit');
    expect(
      (await fragments.render(catalogRequest({ locale: 'AR' }, loads))).status,
    ).toBe('hit');
  });

  it('requires explicit, valid scope and key inputs', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    const bad: Partial<FragmentRequest>[] = [
      { key: 'Catalog' },
      { key: '../catalog' },
      { key: `k${'x'.repeat(91)}` },
      { view: '' },
      { audience: 'everyone' as never },
      { audience: 'tenant', tenant: null },
      { audience: 'private' },
      { tenant: 'Tenant A' },
      { locale: 'en_US' },
      { permissions: ['products read'] },
      { model: { products: [] } as never },
    ];
    for (const overrides of bad)
      await expect(
        fragments.render(catalogRequest(overrides)),
      ).rejects.toThrow();
    expect(
      () => new FragmentCache({ engine: {} as never, assetVersion: 'a1' }),
    ).toThrow(/view engine/);
    expect(
      () => new FragmentCache({ engine, assetVersion: undefined as never }),
    ).toThrow(/asset version/);
  });

  it('refuses fragments that contain a Live snapshot and never stores them', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    const live: FragmentRequest = {
      ...catalogRequest(),
      key: 'live',
      view: 'partials/live',
      model: () => ({ token: 'signed' }),
    };
    await expect(fragments.render(live)).rejects.toBeInstanceOf(
      CacheRefusedError,
    );
    await expect(fragments.render(live)).rejects.toBeInstanceOf(
      CacheRefusedError,
    );
    expect(fragments.renders.cache.metrics.refused).toBe(2);
  });

  it('drops tagged fragments on invalidate and renders fresh data afterwards', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    let products = [{ name: 'Lamp' }];
    const request = (): FragmentRequest => ({
      ...catalogRequest(),
      key: 'catalog.tags',
      model: () => ({ products }),
    });
    await fragments.render(request());
    products = [{ name: 'Chair' }];
    expect((await fragments.render(request())).html.value).toContain('Lamp');
    expect(await fragments.invalidate(['products:tenant-a'])).toBe(1);
    const fresh = await fragments.render(request());
    expect(fresh.status).toBe('miss');
    expect(fresh.html.value).toContain('Chair');
  });

  it('renders several fragments at once with per-fragment statuses', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    await fragments.render(catalogRequest({ key: 'catalog.many' }));
    const set = await fragments.renderAll({
      catalog: catalogRequest({ key: 'catalog.many' }),
      account: {
        key: 'account',
        view: 'partials/account',
        revision: 1,
        audience: 'private',
        binding: 'tenant-a/session-3/carol',
        locale: 'en',
        tenant: null,
        permissions: [],
        ttlMs: 1000,
        model: () => ({ user: 'carol' }),
      },
    });
    expect(set.status).toEqual({ catalog: 'hit', account: 'bypass' });
    expect(set.html.account.value).toBe(
      '<p class="account">Signed in as carol</p>',
    );
    expect(set.html.catalog).toBeInstanceOf(SafeHtml);
  });

  it('coalesces concurrent misses for one key into a single render', async () => {
    const fragments = new FragmentCache({ engine, assetVersion: 'a1' });
    const loads = { count: 0 };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fragments.render(catalogRequest({ key: 'catalog.flight' }, loads)),
      ),
    );
    expect(loads.count).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual([
      'coalesced',
      'coalesced',
      'coalesced',
      'coalesced',
      'miss',
    ]);
  });
});
