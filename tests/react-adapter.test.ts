import type { INestApplication } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HttpSsrGateway,
  InertiaSsrError,
} from '../packages/inertia/dist/index.js';
import {
  PageNotFoundError,
  createPageRegistry,
  createReactPageResolver,
  metaNonce,
} from '../packages/react/dist/index.js';
import type { ReactPageModule } from '../packages/react/dist/index.js';
import {
  exampleFile,
  freePort,
  loadSsrBundle,
  pageObject,
  renderInProduction,
  startInertiaHost,
} from './frontend-support.js';

// Real SSR bundles and a child SSR process: allow for cold module loading.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

function Home(): null {
  return null;
}

describe('@nestvexa/react page resolver', () => {
  const pages = createPageRegistry<ReactPageModule>(
    {
      './pages/Home.tsx': async () => ({ default: Home }),
      './pages/Bad.tsx': async () =>
        ({ default: 42 }) as unknown as ReactPageModule,
    },
    { base: './pages/', extensions: ['.tsx'] },
  );
  const resolve = createReactPageResolver(pages);

  it('resolves registered components only', async () => {
    await expect(resolve('Home')).resolves.toBe(Home);
    await expect(resolve('../../server/main')).rejects.toBeInstanceOf(
      PageNotFoundError,
    );
    await expect(resolve('Bad')).rejects.toBeInstanceOf(PageNotFoundError);
  });

  it('has no CSP nonce outside a browser document', () => {
    expect(metaNonce()).toBeUndefined();
  });
});

describe('React SSR bundle (official @inertiajs/react server path)', () => {
  it('renders the page script and hydratable root with escaped data', async () => {
    const { render } = await loadSsrBundle('inertia-react');
    const attack = '</script><script>alert(1)</script>';
    const result = await render(
      pageObject('Home', { greeting: attack, framework: 'React' }),
    );
    expect(result.head).toEqual([
      '<title data-inertia="">Home · Nestvexa React</title>',
    ]);
    expect(result.body).toMatch(
      /^<script data-page="app" type="application\/json">\{.*\}<\/script><div data-server-rendered="true" id="app">/s,
    );
    expect(result.body).toContain('\\u003c\\/script>\\u003cscript>alert(1)');
    expect(result.body).toContain(
      '<h1>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</h1>',
    );
    expect(result.body).not.toContain('<script>alert(1)');
  });

  it('rejects unknown components and render errors (no SSR error boundary)', async () => {
    const { render } = await loadSsrBundle('inertia-react');
    await expect(render(pageObject('Admin/Secret'))).rejects.toMatchObject({
      name: 'PageNotFoundError',
    });
    await expect(render(pageObject('Broken'))).rejects.toThrow('boom');
  });
});

describe('React SSR under NODE_ENV=production', () => {
  it('rejects a throwing page and renders healthy ones', async () => {
    expect(await renderInProduction('inertia-react', 'Broken')).toBe(
      'error:boom',
    );
    expect(await renderInProduction('inertia-react', 'Home')).toMatch(
      /^ok:\d+$/,
    );
  });
});

describe('official Inertia SSR server process behind HttpSsrGateway', () => {
  let child: ChildProcess | undefined;
  let gateway: HttpSsrGateway;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    const port = await freePort();
    child = spawn(
      process.execPath,
      [exampleFile('inertia-react', 'dist/ssr/ssr.js')],
      {
        env: { ...process.env, NODE_ENV: 'production', SSR_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    gateway = new HttpSsrGateway({
      url: `http://127.0.0.1:${port}`,
      timeoutMs: 5000,
    });
    const deadline = Date.now() + 45000;
    while (!(await gateway.health())) {
      if (Date.now() > deadline)
        throw new Error(`SSR server did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 30000);

  afterAll(async () => {
    child?.kill();
    await Promise.all(apps.map((app) => app.close()));
  });

  it('renders over the documented /render contract', async () => {
    const page = pageObject('Users/Show', {
      user: { id: 7, name: 'Ada', email: 'ada@example.test' },
    });
    const result = await gateway.render(page as never, JSON.stringify(page));
    expect(result.body).toContain('<h1>Ada</h1>');
    expect(result.body).toContain('data-server-rendered="true"');
  });

  it('classifies upstream render failures without exposing them to clients', async () => {
    const page = pageObject('Broken');
    const error: unknown = await gateway
      .render(page as never, JSON.stringify(page))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InertiaSsrError);
    expect((error as InertiaSsrError).type).toBe('render');
  });

  it('serves SSR documents through Nest, then falls back or fails when the process stops', async () => {
    const fallback = await startInertiaHost(gateway, 'fallback', apps);
    const strict = await startInertiaHost(gateway, 'strict', apps);
    const html = await (await fetch(`${fallback}/`)).text();
    expect(html).toContain('<h1>Hello from Nest</h1>');
    expect(html).toContain('data-server-rendered="true"');
    const broken = await fetch(`${fallback}/broken`);
    expect(broken.status).toBe(200);
    expect(await broken.text()).toContain('<div id="app"></div>');
    expect((await fetch(`${strict}/broken`)).status).toBe(500);

    child?.kill();
    await expect.poll(() => gateway.health(), { timeout: 10000 }).toBe(false);
    const down = await fetch(`${fallback}/`);
    expect(down.status).toBe(200);
    const body = await down.text();
    expect(body).not.toContain('data-server-rendered');
    expect(body).toContain('<div id="app"></div>');
    expect((await fetch(`${strict}/`)).status).toBe(500);
  });
});
