import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ViteConfigurationError,
  ViteUnavailableError,
  createViteDevServer,
} from '../packages/vite/dist/index.js';
import type { ViteDevHandle } from '../packages/vite/dist/index.js';

// Starts a real Vite dev server: allow for cold dependency optimization.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

describe('createViteDevServer guards', () => {
  it('requires an absolute root', async () => {
    await expect(createViteDevServer({ root: 'relative' })).rejects.toThrow(
      ViteConfigurationError,
    );
  });

  it('refuses to start with NODE_ENV=production unless explicitly allowed', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(
        createViteDevServer({ root: tmpdir(), loadVite: async () => ({}) }),
      ).rejects.toThrow(/disabled when NODE_ENV=production/);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('fails clearly when Vite is not installed', async () => {
    const error: unknown = await createViteDevServer({
      root: tmpdir(),
      loadVite: () => Promise.reject(new Error("Cannot find package 'vite'")),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ViteUnavailableError);
    expect((error as Error).message).toMatch(/optional peer dependency `vite`/);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('rejects a module that is not Vite', async () => {
    await expect(
      createViteDevServer({ root: tmpdir(), loadVite: async () => ({ x: 1 }) }),
    ).rejects.toThrow(/not Vite/);
  });
});

describe('createViteDevServer with real Vite (middleware mode)', () => {
  let root: string;
  let handle: ViteDevHandle;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nestvexa-vite-dev-'));
    await writeFile(
      join(root, 'ssr.ts'),
      [
        "import { label } from './label';",
        'export function render(page: { component: string }) {',
        '  return { head: [], body: `<div data-server-rendered="true" id="app">${label}:${page.component}</div>` };',
        '}',
      ].join('\n'),
    );
    await writeFile(join(root, 'label.ts'), "export const label = 'v1';");
    await writeFile(join(root, 'app.ts'), "console.log('client entry');");
    server = createServer();
    handle = await createViteDevServer({
      root,
      configFile: false,
      hmrServer: server,
    });
    server.on('request', (request, response) =>
      handle.middlewares(request, response, () => {
        response.statusCode = 404;
        response.end('not vite');
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60000);

  afterAll(async () => {
    await handle?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('serves the HMR client and transformed entries', async () => {
    const client = await fetch(`${base}/@vite/client`);
    expect(client.status).toBe(200);
    expect(client.headers.get('content-type')).toContain('javascript');
    const entry = await fetch(`${base}/app.ts`);
    expect(await entry.text()).toContain('client entry');
    expect((await fetch(`${base}/nope-route`)).status).toBe(404);
  });

  it('renders through ssrLoadModule and picks up edits without a restart', async () => {
    const renderer = handle.ssrRenderer('/ssr.ts');
    const page = { component: 'Home', props: {}, url: '/', version: 'dev' };
    expect((await renderer.render(page, JSON.stringify(page))).body).toContain(
      'v1:Home',
    );
    await writeFile(join(root, 'label.ts'), "export const label = 'v2';");
    await expect
      .poll(
        async () => (await renderer.render(page, JSON.stringify(page))).body,
        { timeout: 10000 },
      )
      .toContain('v2:Home');
  });
});
