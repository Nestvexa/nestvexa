import { createElement } from '../packages/react/node_modules/react/index.js';
import { defineComponent, h } from '../packages/vue/node_modules/vue/index.mjs';
import { describe, expect, it, vi } from 'vitest';
import { createPageRegistry } from '../packages/vite/src/pages.js';
import type { InertiaPageLike } from '../packages/vite/src/pages.js';
import {
  createReactSsrRender,
  startReactSsrServer,
} from '../packages/react/src/ssr.js';
import type { ReactPageModule } from '../packages/react/src/pages.js';
import {
  createVueSsrRender,
  startVueSsrServer,
} from '../packages/vue/src/ssr.js';
import type { VuePageModule } from '../packages/vue/src/pages.js';
import { createSvelteSsrRender } from '../packages/svelte/src/ssr.js';
import type { SveltePageModule } from '../packages/svelte/src/pages.js';
import type { SvelteCreateInertiaApp } from '../packages/svelte/src/types.js';

// In-process SSR through the official @inertiajs/react and @inertiajs/vue3
// server paths, imported from the package sources so the coverage gate sees
// them (the adapter suites render prebuilt example bundles instead). The
// official HTTP server factories are replaced by spies: starting them would
// bind a port and expose upstream's `/shutdown`, which exits the process.

const reactServer = vi.hoisted(() => vi.fn());
const vueServer = vi.hoisted(() => vi.fn());
vi.mock(
  '../packages/react/node_modules/@inertiajs/react/dist/server.js',
  () => ({
    default: reactServer,
  }),
);
vi.mock('../packages/vue/node_modules/@inertiajs/vue3/dist/server.js', () => ({
  default: vueServer,
}));

const page = (
  component: string,
  props: Record<string, unknown> = {},
): InertiaPageLike => ({
  component,
  props: { errors: {}, ...props },
  url: '/users',
  version: 'v1',
});

describe('React SSR render (source)', () => {
  const Users = ({ name }: { name: string }) =>
    createElement('p', { id: 'user' }, `Hello ${name}`);
  const Broken = (): null => {
    throw new Error('react boom');
  };
  const pages = createPageRegistry<ReactPageModule>(
    {
      './pages/Users.tsx': async () => ({ default: Users }),
      './pages/Broken.tsx': async () => ({ default: Broken }),
    },
    { base: './pages/', extensions: ['.tsx'] },
  );

  it('renders hydratable, escaped markup with the title callback and root id', async () => {
    const titles: string[] = [];
    const render = createReactSsrRender({
      pages,
      id: 'root',
      title: (title) => {
        titles.push(title);
        return `${title} · Test`;
      },
    });
    const result = await render(page('Users', { name: '<b>Ada</b>' }));
    expect(result.body).toContain('data-server-rendered="true"');
    expect(result.body).toContain('id="root"');
    expect(result.body).toContain('Hello &lt;b&gt;Ada&lt;/b&gt;');
    expect(result.body).not.toContain('<b>Ada</b>');
    // The cached server render serves later requests independently.
    const second = await render(page('Users', { name: 'Grace' }));
    expect(second.body).toContain('Hello Grace');
    expect(second.body).not.toContain('Ada');
  });

  it('defaults the root id to app and accepts a layout callback', async () => {
    const render = createReactSsrRender({ pages, layout: () => undefined });
    expect((await render(page('Users', { name: 'x' }))).body).toContain(
      'id="app"',
    );
  });

  it('rejects unknown pages', async () => {
    const render = createReactSsrRender({ pages });
    await expect(render(page('Missing'))).rejects.toMatchObject({
      name: 'PageNotFoundError',
    });
  });

  it('starts the official server bound to loopback by default', () => {
    const render = createReactSsrRender({ pages });
    startReactSsrServer(render);
    startReactSsrServer(render, { port: 4121, host: '::1', cluster: true });
    expect(reactServer.mock.calls).toEqual([
      [
        render,
        { port: 13714, host: '127.0.0.1', cluster: false, formatErrors: true },
      ],
      [render, { port: 4121, host: '::1', cluster: true, formatErrors: true }],
    ]);
    expect(() => startReactSsrServer(render, { port: 0 })).toThrow(
      'SSR server port must be 1–65535',
    );
  });
});

describe('Vue SSR render (source)', () => {
  const Users = defineComponent({
    props: { name: { type: String, required: true } },
    setup: (props) => () => h('p', { id: 'user' }, `Hello ${props.name}`),
  });
  const Broken = defineComponent({
    setup: () => () => {
      throw new Error('vue boom');
    },
  });
  const pages = createPageRegistry<VuePageModule>(
    {
      './pages/Users.vue': async () => ({ default: Users }),
      './pages/Broken.vue': async () => ({ default: Broken }),
    },
    { base: './pages/', extensions: ['.vue'] },
  );

  it('renders escaped markup and installs the enhance plugins per app', async () => {
    const enhanced: unknown[] = [];
    const render = createVueSsrRender({
      pages,
      id: 'root',
      title: (title) => title,
      layout: () => undefined,
      enhance: (app) => {
        enhanced.push(app);
      },
    });
    const result = await render(page('Users', { name: '<i>Ada</i>' }));
    expect(result.body).toContain('data-server-rendered="true"');
    expect(result.body).toContain('id="root"');
    expect(result.body).toContain('Hello &lt;i&gt;Ada&lt;/i&gt;');
    await render(page('Users', { name: 'Grace' }));
    // A fresh createSSRApp per render: no application state shared.
    expect(enhanced).toHaveLength(2);
    expect(enhanced[0]).not.toBe(enhanced[1]);
  });

  it('rejects a throwing page instead of rendering empty markup and keeps the host error handler', async () => {
    const observed: unknown[] = [];
    const render = createVueSsrRender({
      pages,
      enhance: (app) => {
        app.config.errorHandler = (error) => {
          observed.push(error);
        };
      },
    });
    await expect(render(page('Broken'))).rejects.toThrow('vue boom');
    expect(observed).toHaveLength(1);
    // A healthy page after a failure renders normally.
    expect((await render(page('Users', { name: 'ok' }))).body).toContain(
      'Hello ok',
    );
  });

  it('rejects without an enhance hook too', async () => {
    const render = createVueSsrRender({ pages });
    await expect(render(page('Broken'))).rejects.toThrow('vue boom');
  });

  it('starts the official server with loopback defaults', () => {
    const render = createVueSsrRender({ pages });
    startVueSsrServer(render, { formatErrors: false });
    expect(vueServer).toHaveBeenCalledWith(render, {
      port: 13714,
      host: '127.0.0.1',
      cluster: false,
      formatErrors: false,
    });
  });
});

describe('Svelte SSR render (source)', () => {
  const pages = createPageRegistry<SveltePageModule>(
    {
      './pages/Home.svelte': async () => ({
        default: (() => ({})) as unknown as SveltePageModule['default'],
      }),
    },
    { base: './pages/', extensions: ['.svelte'] },
  );

  it('creates the upstream render once with the configured options', async () => {
    const options: Record<string, unknown>[] = [];
    const create = (async (input: Record<string, unknown>) => {
      options.push(input);
      return async (current: InertiaPageLike) => ({
        head: ['<title>t</title>'],
        body: `<div id="${String(input['id'])}">${current.component}</div>`,
      });
    }) as unknown as SvelteCreateInertiaApp;
    const render = createSvelteSsrRender({
      createInertiaApp: create,
      pages,
      id: 'root',
      layout: () => undefined,
    });
    expect(await render(page('Home'))).toEqual({
      head: ['<title>t</title>'],
      body: '<div id="root">Home</div>',
    });
    await render(page('Home'));
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ id: 'root' });
    expect(typeof options[0]?.['resolve']).toBe('function');
    expect(typeof options[0]?.['layout']).toBe('function');
  });

  it('fails when upstream returns no render function and retries on the next request', async () => {
    let calls = 0;
    const create = (async () => {
      calls++;
      if (calls === 1) return undefined;
      return async () => ({ head: [], body: '<div id="app"></div>' });
    }) as unknown as SvelteCreateInertiaApp;
    const render = createSvelteSsrRender({ createInertiaApp: create, pages });
    await expect(render(page('Home'))).rejects.toThrow(
      '@inertiajs/svelte did not return an SSR render function',
    );
    expect((await render(page('Home'))).body).toBe('<div id="app"></div>');
    expect(calls).toBe(2);
  });
});
