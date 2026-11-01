import type { INestApplication } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { moduleSsrRenderer } from '../packages/vite/dist/index.js';
import {
  PageNotFoundError,
  createPageRegistry,
  createSveltePageResolver,
  mountSvelteInertiaApp,
} from '../packages/svelte/dist/index.js';
import type { SveltePageModule } from '../packages/svelte/dist/index.js';
import { createSvelteSsrRender } from '../packages/svelte/dist/ssr.js';
import {
  exampleFile,
  loadSsrBundle,
  pageObject,
  renderInProduction,
  startInertiaHost,
} from './frontend-support.js';

// Real SSR bundles: allow for cold module loading.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe('@nestvexa/svelte page resolver and injection', () => {
  const module = {
    default: (() => ({})) as unknown as SveltePageModule['default'],
    layout: 'custom-layout',
  };
  const pages = createPageRegistry<SveltePageModule>(
    {
      './pages/Home.svelte': async () => module,
      './pages/Bad.svelte': async () =>
        ({ default: 'nope' }) as unknown as SveltePageModule,
    },
    { base: './pages/', extensions: ['.svelte'] },
  );

  it('resolves to the page module so module-level layouts survive', async () => {
    const resolve = createSveltePageResolver(pages);
    await expect(resolve('Home')).resolves.toBe(module);
    await expect(resolve('Bad')).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(resolve('Home/../Bad')).rejects.toBeInstanceOf(
      PageNotFoundError,
    );
  });

  it('requires the official createInertiaApp to be injected', async () => {
    expect(() =>
      createSvelteSsrRender({
        createInertiaApp: undefined as never,
        pages,
      }),
    ).toThrow(/createInertiaApp from @inertiajs\/svelte/);
    await expect(
      mountSvelteInertiaApp({ createInertiaApp: 1 as never, pages }),
    ).rejects.toThrow(TypeError);
  });

  it('reports boot failures instead of throwing and leaves markup alone', async () => {
    const seen: unknown[] = [];
    const failure = new Error('resolve failed');
    const handle = await mountSvelteInertiaApp({
      createInertiaApp: (async () => {
        throw failure;
      }) as never,
      pages,
      onError: (error) => seen.push(error),
    });
    expect(handle).toEqual({ mode: 'failed', error: failure });
    expect(seen).toEqual([failure]);
  });
});

describe('Svelte SSR bundle (official @inertiajs/svelte + svelte/server)', () => {
  it('renders hydratable markup with Svelte head output', async () => {
    const { render } = await loadSsrBundle('inertia-svelte');
    const result = await render(
      pageObject('Users/Show', {
        user: { id: 3, name: 'Grace & co', email: 'g@example.test' },
      }),
    );
    expect(result.head.join('')).toContain(
      '<title>Grace &amp; co · Nestvexa Svelte</title>',
    );
    expect(result.body).toContain('<div data-server-rendered="true" id="app">');
    expect(result.body).toContain('Grace &amp; co</h1>');
  });

  it('propagates render errors and unknown components', async () => {
    const { render } = await loadSsrBundle('inertia-svelte');
    await expect(render(pageObject('Broken'))).rejects.toThrow('boom');
    await expect(render(pageObject('Nope'))).rejects.toMatchObject({
      name: 'PageNotFoundError',
    });
  });
});

describe('Svelte SSR under NODE_ENV=production', () => {
  it('rejects a throwing page and renders healthy ones', async () => {
    expect(await renderInProduction('inertia-svelte', 'Broken')).toBe(
      'error:boom',
    );
    expect(await renderInProduction('inertia-svelte', 'Home')).toMatch(
      /^ok:\d+$/,
    );
  });
});

describe('in-process Svelte SSR through moduleSsrRenderer and @nestvexa/inertia', () => {
  const apps: INestApplication[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('serves SSR documents and applies fallback/strict modes', async () => {
    const bundle = exampleFile('inertia-svelte', 'dist/ssr/ssr.js');
    const fallback = await startInertiaHost(
      moduleSsrRenderer(bundle),
      'fallback',
      apps,
    );
    const strict = await startInertiaHost(
      moduleSsrRenderer(bundle),
      'strict',
      apps,
    );
    const html = await (await fetch(`${fallback}/`)).text();
    expect(html).toContain('data-server-rendered="true"');
    expect(html).toContain('Hello from Nest</h1>');
    expect((await fetch(`${fallback}/broken`)).status).toBe(200);
    expect((await fetch(`${strict}/broken`)).status).toBe(500);
  });
});
