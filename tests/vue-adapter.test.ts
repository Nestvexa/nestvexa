import type { INestApplication } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { moduleSsrRenderer } from '../packages/vite/dist/index.js';
import {
  ErrorBoundary,
  PageNotFoundError,
  createPageRegistry,
  createVuePageResolver,
  metaNonce,
} from '../packages/vue/dist/index.js';
import type { VuePageModule } from '../packages/vue/dist/index.js';
import {
  exampleFile,
  loadSsrBundle,
  pageObject,
  renderInProduction,
  startInertiaHost,
} from './frontend-support.js';

// Real SSR bundles: allow for cold module loading.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe('@nestvexa/vue page resolver', () => {
  const Home = { name: 'Home', render: () => null };
  const resolve = createVuePageResolver(
    createPageRegistry<VuePageModule>(
      {
        './pages/Home.vue': async () => ({ default: Home }),
        './pages/Empty.vue': async () =>
          ({ default: undefined }) as unknown as VuePageModule,
      },
      { base: './pages/', extensions: ['.vue'] },
    ),
  );

  it('resolves registered components only', async () => {
    await expect(resolve('Home')).resolves.toBe(Home);
    await expect(resolve('Empty')).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(resolve('constructor')).rejects.toBeInstanceOf(
      PageNotFoundError,
    );
  });

  it('exports a named error boundary component', () => {
    expect(ErrorBoundary.name).toBe('NestvexaErrorBoundary');
    expect(metaNonce()).toBeUndefined();
  });
});

describe('Vue SSR bundle (official @inertiajs/vue3 + vue/server-renderer)', () => {
  it('renders hydratable markup with escaped page data', async () => {
    const { render } = await loadSsrBundle('inertia-vue');
    const result = await render(
      pageObject('Users/Index', {
        users: [{ id: 1, name: '<b>Ada</b>', email: 'a@example.test' }],
      }),
    );
    expect(result.head).toEqual([
      '<title data-inertia="">Users · Nestvexa Vue</title>',
    ]);
    expect(result.body).toContain('<div data-server-rendered="true" id="app">');
    expect(result.body).toContain('&lt;b&gt;Ada&lt;/b&gt;');
    expect(result.body).toContain('\\u003cb>Ada\\u003c\\/b>');
    expect(result.body).not.toContain('<b>Ada</b>');
  });

  it('lets render errors propagate instead of shipping boundary markup', async () => {
    const { render } = await loadSsrBundle('inertia-vue');
    await expect(render(pageObject('Broken'))).rejects.toThrow('boom');
    await expect(render(pageObject('Missing'))).rejects.toMatchObject({
      name: 'PageNotFoundError',
    });
  });
});

describe('Vue SSR under NODE_ENV=production', () => {
  // Vue's production build only logs unhandled component errors during SSR;
  // createVueSsrRender must still reject instead of shipping empty markup.
  it('rejects a throwing page and renders healthy ones', async () => {
    expect(await renderInProduction('inertia-vue', 'Broken')).toBe(
      'error:boom',
    );
    expect(await renderInProduction('inertia-vue', 'Home')).toMatch(/^ok:\d+$/);
  });
});

describe('in-process Vue SSR through moduleSsrRenderer and @nestvexa/inertia', () => {
  const apps: INestApplication[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('serves SSR documents, falls back on render errors and fails in strict mode', async () => {
    const bundle = exampleFile('inertia-vue', 'dist/ssr/ssr.js');
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
    expect(html).toContain('<h1>Hello from Nest</h1>');
    const broken = await fetch(`${fallback}/broken`);
    expect(broken.status).toBe(200);
    expect(await broken.text()).toContain('<div id="app"></div>');
    expect((await fetch(`${strict}/broken`)).status).toBe(500);
    expect((await fetch(`${strict}/`)).status).toBe(200);
  });
});
