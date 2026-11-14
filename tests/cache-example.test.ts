import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheRefusedError } from '../packages/cache/dist/index.js';
import { createDataCacheApp } from '../examples/data-cache/dist/app.js';

// examples/data-cache over HTTP (DATA-005 to DATA-008): tenant fragments are
// shared only within a tenant and permission scope, personal fragments are
// never stored, writes invalidate by tag, pages with Live components can
// never be cached, and Live state lives in the SQLite custom store.

const port = 4010;
const origin = `http://127.0.0.1:${port}`;
let started: Awaited<ReturnType<typeof createDataCacheApp>>;
beforeAll(async () => {
  started = await createDataCacheApp({
    port,
    databasePath: ':memory:',
    assetVersion: 'test',
  });
  await started.app.listen(port, '127.0.0.1');
}, 180_000);
afterAll(async () => {
  await started?.app.close();
});

async function signIn(user: string, language = 'en') {
  const first = await fetch(origin + '/');
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const csrf =
    /name="_csrf" value="([^"]+)"/.exec(await first.text())?.[1] ?? '';
  const login = await fetch(origin + '/session', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, user }).toString(),
  });
  expect(login.status).toBe(303);
  const page = () =>
    fetch(origin + '/', { headers: { cookie, 'accept-language': language } });
  return { cookie, csrf, page };
}
const form = (cookie: string, body: Record<string, string>) => ({
  method: 'POST',
  redirect: 'manual' as const,
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const live = (
  cookie: string,
  csrf: string,
  snapshot: string,
  revision: number,
) => ({
  method: 'POST',
  headers: {
    cookie,
    origin,
    'content-type': 'application/json',
    'x-nestvexa-csrf': csrf,
  },
  body: JSON.stringify({
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot,
    revision,
    updates: {},
    input: null,
  }),
});

describe('examples/data-cache', () => {
  it('caches tenant fragments, never personal ones, invalidates on write and keeps Live state in the custom store', async () => {
    const { catalog } = started;
    const alice = await signIn('alice');
    const first = await alice.page();
    const html = await first.text();
    expect(first.headers.get('x-cache-catalog')).toBe('miss');
    expect(first.headers.get('x-cache-account')).toBe('bypass');
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(html).toContain('Desk lamp');
    expect(html).toContain('data-nv-snapshot');
    // Same tenant and permission scope on another session: shared fragment.
    const aliceTablet = await signIn('alice');
    expect((await aliceTablet.page()).headers.get('x-cache-catalog')).toBe(
      'hit',
    );
    // Bob (viewer) has another permission scope; Carol another tenant.
    const bob = await signIn('bob');
    const bobPage = await bob.page();
    expect(bobPage.headers.get('x-cache-catalog')).toBe('miss');
    expect(await bobPage.text()).not.toContain('href="#edit"');
    const carol = await signIn('carol');
    const carolHtml = await (await carol.page()).text();
    expect(carolHtml).toContain('Kettle');
    expect(carolHtml).not.toContain('Desk lamp');
    // Arabic is its own key.
    const arabic = await signIn('alice', 'ar');
    const arabicPage = await arabic.page();
    expect(arabicPage.headers.get('x-cache-catalog')).toBe('miss');
    expect(await arabicPage.text()).toContain('dir="rtl"');
    expect(catalog.renderCounts.account).toBe(5);
    // Viewers cannot write; an admin write invalidates every tenant-a fragment.
    const forbidden = await fetch(
      origin + '/products',
      form(bob.cookie, { _csrf: bob.csrf, name: 'Stolen' }),
    );
    expect(forbidden.status).toBe(403);
    const added = await fetch(
      origin + '/products',
      form(alice.cookie, { _csrf: alice.csrf, name: 'Pen' }),
    );
    expect(added.status).toBe(303);
    const after = await bob.page();
    expect(after.headers.get('x-cache-catalog')).toBe('miss');
    expect(await after.text()).toContain('Pen');
    expect((await carol.page()).headers.get('x-cache-catalog')).toBe('hit');
    // The page with a mounted Live component can never enter the cache.
    await expect(
      catalog.renders.render(
        {
          component: 'page',
          revision: 1,
          renderer: 'hbs',
          locale: 'en',
          tenant: 'tenant-a',
          permissions: [],
          assetVersion: 'test',
          audience: 'tenant',
          ttlMs: 1000,
        },
        () => html,
      ),
    ).rejects.toBeInstanceOf(CacheRefusedError);
    // Live actions run against the SQLite custom store, bound to Alice.
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
    const csrf = /data-nv-csrf="([^"]+)"/.exec(html)?.[1] ?? '';
    const action = await fetch(
      origin + '/_nestvexa/live/cart/add',
      live(alice.cookie, csrf, snapshot, 0),
    );
    expect(action.ok).toBe(true);
    expect(await action.json()).toMatchObject({ state: { items: 1 } });
    const stolen = await fetch(
      origin + '/_nestvexa/live/cart/add',
      live(bob.cookie, bob.csrf, snapshot, 1),
    );
    expect(stolen.status).toBe(410);
    const metrics = await fetch(origin + '/api/cache', {
      headers: { cookie: alice.cookie },
    });
    expect(await metrics.json()).toMatchObject({
      metrics: { invalidations: 1, bypassed: 7 },
    });
    const denied = await fetch(origin + '/api/cache', {
      headers: { cookie: bob.cookie },
    });
    expect(denied.status).toBe(403);
  }, 120_000);
});
