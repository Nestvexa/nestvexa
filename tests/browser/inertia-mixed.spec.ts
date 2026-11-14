import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cspViolations,
  exampleUrl,
  inertiaRequests,
  markDocument,
  observe,
  sameDocument,
} from './inertia-framework-suite.js';

// examples/inertia-mixed: one Nest backend serving an HBS route plus React,
// Vue and Svelte Inertia roots on /react, /vue and /svelte. Each root is a
// separate Vite build with its own manifest, asset version and SSR bundle.
const base = exampleUrl('MIXED', 3109);
// Full document loads across roots are slow on loaded hosts.
const wait = expect.configure({ timeout: 20000 });
const roots = ['react', 'vue', 'svelte'] as const;
const labels = { react: 'React', vue: 'Vue', svelte: 'Svelte' } as const;
const foreign = {
  react: /\bvue\b|svelte/i,
  vue: /react|svelte/i,
  svelte: /react|\bvue\b/i,
} as const;

function manifest(
  root: (typeof roots)[number],
): Record<string, { file: string }> {
  const path = fileURLToPath(
    new URL(
      `../../examples/inertia-mixed/dist/${root}/client/.vite/manifest.json`,
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    { file: string }
  >;
}

async function hydratedAs(page: Page, root: string): Promise<void> {
  await wait(page.locator(`html[data-hydrated="${root}"]`)).toHaveCount(1);
}

test.describe('mixed Nest host: HBS + React + Vue + Svelte roots', () => {
  test.describe.configure({ timeout: 120000 });

  test('each root has a separate Vite manifest with no foreign framework modules', () => {
    const files = new Map<string, string>();
    for (const root of roots) {
      const entries = manifest(root);
      const keys = Object.keys(entries);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toMatch(foreign[root]);
        expect(entries[key]?.file).toMatch(/^assets\//);
        const file = `${root}:${entries[key]?.file ?? ''}`;
        expect(files.has(file)).toBe(false);
        files.set(file, root);
      }
      expect(keys).toContain(
        root === 'react' ? 'client/react/app.tsx' : `client/${root}/app.ts`,
      );
    }
  });

  test('every root document is server-rendered and loads only its own bundle', async ({
    request,
  }) => {
    for (const root of roots) {
      const response = await request.get(`${base}/${root}`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-server-rendered="true"');
      expect(html).toMatch(new RegExp(`<h1[^>]*>${labels[root]} home</h1>`));
      expect(html).toContain(`src="/build/${root}/assets/`);
      for (const other of roots)
        if (other !== root) expect(html).not.toContain(`/build/${other}/`);
      const version = /"version":"([^"]+)"/.exec(html)?.[1];
      expect(version).toMatch(new RegExp(`^${root}:[0-9a-f]{16}$`));
    }
    const hbs = await request.get(`${base}/`);
    expect(await hbs.text()).toContain('<h1>Mixed host</h1>');
  });

  test('same-root navigation stays XHR; cross-root navigation is a full page load', async ({
    page,
  }) => {
    const observed = await observe(page);
    const builds = new Set<string>();
    page.on('request', (request) => {
      const match = /\/build\/(react|vue|svelte)\//.exec(request.url());
      if (match?.[1]) builds.add(match[1]);
    });
    await page.goto(`${base}/react`);
    await hydratedAs(page, 'react');
    expect([...builds]).toEqual(['react']);
    await markDocument(page);
    const xhr = inertiaRequests(page);
    await page.getByRole('link', { name: 'React about' }).click();
    await wait(
      page.getByRole('heading', { name: 'React about' }),
    ).toBeVisible();
    expect(await sameDocument(page)).toBe(true);
    expect(xhr.map((request) => new URL(request.url()).pathname)).toEqual([
      '/react/about',
    ]);

    // Inertia Link into the Vue root: the server answers the XHR with 409 and
    // X-Inertia-Location (versions are namespaced per root), so the official
    // client performs a full document visit.
    const conflict = page.waitForResponse(
      (response) =>
        response.url() === `${base}/vue` && response.status() === 409,
    );
    await page.getByRole('link', { name: 'Vue root' }).click();
    expect((await conflict).headers()['x-inertia-location']).toBe('/vue');
    await wait(page.getByRole('heading', { name: 'Vue home' })).toBeVisible();
    await hydratedAs(page, 'vue');
    expect(await sameDocument(page)).toBe(false);
    await markDocument(page);
    await page.getByRole('link', { name: 'Vue about' }).click();
    await wait(page.getByRole('heading', { name: 'Vue about' })).toBeVisible();
    expect(await sameDocument(page)).toBe(true);

    await page.getByRole('link', { name: 'Svelte root' }).click();
    await wait(
      page.getByRole('heading', { name: 'Svelte home' }),
    ).toBeVisible();
    await hydratedAs(page, 'svelte');
    expect(await sameDocument(page)).toBe(false);
    await markDocument(page);
    await page.getByRole('link', { name: 'Svelte about' }).click();
    await wait(
      page.getByRole('heading', { name: 'Svelte about' }),
    ).toBeVisible();
    expect(await sameDocument(page)).toBe(true);

    // Plain link to the HBS route served by the same Nest host.
    await page.getByRole('link', { name: 'HBS index' }).click();
    await wait(page.getByRole('heading', { name: 'Mixed host' })).toBeVisible();
    expect(await sameDocument(page)).toBe(false);
    await page.getByRole('link', { name: 'React root' }).click();
    await hydratedAs(page, 'react');
    await wait(page.getByRole('heading', { name: 'React home' })).toBeVisible();

    expect(observed.errors).toEqual([]);
    // Chromium logs the deliberate cross-root 409 responses as resource errors.
    expect(
      observed.console.filter((line) => !line.includes('status of 409')),
    ).toEqual([]);
  });

  test('the Live route loads its Vite manifest assets through viteTags with the CSP nonce', async ({
    request,
  }) => {
    const response = await request.get(`${base}/live`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const nonce =
      /'nonce-([^']+)'/.exec(
        response.headers()['content-security-policy'] ?? '',
      )?.[1] ?? '';
    expect(nonce).not.toBe('');
    const head = html.slice(0, html.indexOf('</head>'));
    const tags = (pattern: RegExp) =>
      [...head.matchAll(pattern)].map((match) => match[0]);
    // Live boot module (nvScripts) plus the Live app's manifest tags, each
    // module carrying this response's nonce.
    expect(head).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
    expect(
      tags(/<script type="module" src="([^"]+)" nonce="([^"]+)"><\/script>/g),
    ).toHaveLength(3);
    for (const tag of tags(/<script type="module"[^>]*>/g))
      expect(tag).toContain(`nonce="${nonce}"`);
    expect(head).toContain('src="/_nestvexa/boot.js"');
    expect(
      tags(/<script type="module" src="\/build\/live\/assets\/[^"]+\.js"/g),
    ).toHaveLength(2);
    expect(
      tags(/<link rel="stylesheet" href="\/build\/live\/assets\/[^"]+\.css">/g),
    ).toHaveLength(1);
    const preloads = tags(
      /<link rel="modulepreload" href="\/build\/live\/assets\/[^"]+\.js"[^>]*>/g,
    );
    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toContain(`nonce="${nonce}"`);
    for (const root of roots) expect(html).not.toContain(`/build/${root}/`);
    expect(html).toContain('id="live-count"');
  });

  test('a Live component works next to the Inertia roots and the API route is preserved', async ({
    page,
    request,
  }) => {
    const observed = await observe(page);
    await page.goto(`${base}/live`);
    await wait(page.locator('html')).toHaveAttribute(
      'data-enhanced',
      'live-assets widgets',
    );
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--live-assets')
          .trim(),
      ),
    ).toBe('loaded');
    await page.getByRole('button', { name: 'Increment' }).click();
    await wait(page.locator('#live-count')).toHaveText('1');
    await page.getByRole('button', { name: 'Increment' }).click();
    await wait(page.locator('#live-count')).toHaveText('2');
    expect(await cspViolations(page)).toEqual([]);
    expect(observed.errors).toEqual([]);
    // The JSON API route keeps answering plain JSON to browser code on a page
    // served by the same host (no page object, no Inertia headers).
    const fromPage = await page.evaluate(async () => {
      const response = await fetch('/api/health', {
        headers: { Accept: 'application/json' },
      });
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: (await response.json()) as unknown,
      };
    });
    expect(fromPage.status).toBe(200);
    expect(fromPage.type).toMatch(/^application\/json/);
    expect(fromPage.body).toEqual({
      status: 'ok',
      roots: ['react', 'vue', 'svelte'],
    });
    const direct = await request.get(`${base}/api/health`);
    expect(direct.status()).toBe(200);
    expect(await direct.json()).toEqual({
      status: 'ok',
      roots: ['react', 'vue', 'svelte'],
    });
    expect(direct.headers()['x-inertia']).toBeUndefined();
    // From the Live page a plain link opens the React root (full load).
    await markDocument(page);
    await page.getByRole('link', { name: 'React root' }).click();
    await hydratedAs(page, 'react');
    expect(await sameDocument(page)).toBe(false);
  });
  // VISION-017: a framework (Inertia React) page hosting an isolated Live
  // element. React owns the page and an empty host; the Live client, scoped to
  // that host, owns everything inside it.
  test('an Inertia React page hosts an isolated Live element across Inertia visits', async ({
    page,
  }) => {
    const observed = await observe(page);
    const live: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/_nestvexa/'))
        live.push(new URL(request.url()).pathname);
    });
    await page.goto(`${base}/react/about`);
    await hydratedAs(page, 'react');
    await markDocument(page);
    const xhr = inertiaRequests(page);
    // Inertia visit into the hosting page: the island mounts client-side.
    await page.getByRole('link', { name: 'React live' }).click();
    await wait(
      page.locator('#live-host[data-live-mounted="true"]'),
    ).toHaveCount(1);
    await wait(page.locator('#live-count')).toHaveText('0');
    const increment = page.getByRole('button', { name: 'Increment' });
    await increment.click();
    await wait(page.locator('#live-count')).toHaveText('1');
    await increment.click();
    await wait(page.locator('#live-count')).toHaveText('2');
    // Live actions are Live protocol requests, never Inertia visits.
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(xhr.map((request) => new URL(request.url()).pathname)).toEqual([
      '/react/live',
    ]);
    // React state survives Live morphs; a React re-render leaves Live alone.
    await page.getByRole('button', { name: 'React click' }).click();
    await page.getByRole('button', { name: 'React click' }).click();
    await wait(page.locator('#react-clicks')).toHaveText('2');
    await wait(page.locator('#live-count')).toHaveText('2');
    await increment.click();
    await wait(page.locator('#live-count')).toHaveText('3');
    await wait(page.locator('#react-clicks')).toHaveText('2');
    // A partial reload of another prop keeps the same Live DOM and state.
    await page.evaluate(() => {
      const output = document.querySelector('#live-count');
      if (output) Reflect.set(output, '__kept', true);
    });
    const stamp = await page.locator('#stamp').textContent();
    const partial = page.waitForRequest(
      (request) =>
        request.headers()['x-inertia-partial-data'] === 'stamp' &&
        new URL(request.url()).pathname === '/react/live',
    );
    await page.getByRole('button', { name: 'Reload stamp' }).click();
    await partial;
    await wait(page.locator('#stamp')).not.toHaveText(stamp ?? '');
    await wait(page.locator('#live-count')).toHaveText('3');
    expect(
      await page
        .locator('#live-count')
        .evaluate((output) => Reflect.get(output, '__kept') === true),
    ).toBe(true);
    // Leaving through Inertia disposes the island; React navigation works
    // after Live activity and remains a same-document XHR visit.
    await page.getByRole('link', { name: 'React about' }).click();
    await wait(
      page.getByRole('heading', { name: 'React about' }),
    ).toBeVisible();
    await wait(page.locator('#live-host')).toHaveCount(0);
    // Returning mounts a fresh server component with a new client; the
    // disposed client left no ownership claim behind.
    await page.getByRole('link', { name: 'React live' }).click();
    await wait(
      page.locator('#live-host[data-live-mounted="true"]'),
    ).toHaveCount(1);
    await wait(page.locator('#live-count')).toHaveText('0');
    await increment.click();
    await wait(page.locator('#live-count')).toHaveText('1');
    expect(await sameDocument(page)).toBe(true);
    await wait(page.locator('#live-host')).not.toHaveAttribute(
      'data-live-error',
      /.*/,
    );
    expect(await cspViolations(page)).toEqual([]);
    expect(observed.errors).toEqual([]);
    expect(observed.console).toEqual([]);
  });
});
