import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';

interface ModelFixtureRequest {
  readonly url: string;
  readonly revision: number;
  readonly updates: Readonly<Record<string, unknown>>;
}
declare global {
  interface Window {
    nvModelLifecycleFixture: typeof import('../packages/client/dist/index.js');
    nvModelSession: {
      client: ReturnType<
        typeof import('../packages/client/dist/index.js').createLiveClient
      >;
      requests: ModelFixtureRequest[];
      errors: { message: string; code: string | null }[];
    };
  }
}

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
let pageErrors: string[];
const html =
  '<!doctype html><html lang="en"><head><title>Model lifecycle fixture</title><script type="module" src="/fixture.js"></script></head><body><main><section data-nv-component="11111111-1111-4111-8111-111111111111" data-nv-name="editor" data-nv-snapshot="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" data-nv-state="{&quot;query&quot;:&quot;&quot;}" data-nv-revision="0" data-nv-endpoint="/live/editor" data-nv-csrf="host-csrf-012345678901234567890123456789"><label>Query <input id="query" nv:model.live.debounce.100ms="query"></label><output nv:text="query"></output><button type="button" nv:click="save">Save</button><div id="boundary"></div></section></main></body></html>';

beforeAll(async () => {
  const assets = new Map(
    [
      'index',
      'protocol',
      'grammar',
      'morph',
      'bindings',
      'events',
      'listeners',
      'models',
      'model-scheduler',
      'loading',
      'control-state',
      'transport',
      'form-reset',
      'focus',
    ].map((name) => [
      `/${name}.js`,
      new URL(`../packages/client/dist/${name}.js`, import.meta.url),
    ]),
  );
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(html);
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; window.nvModelLifecycleFixture = client;",
        );
      return;
    }
    const file = assets.get(pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    void readFile(file, 'utf8').then(
      (source) =>
        response
          .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          .end(source),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing model fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() =>
    Reflect.has(window, 'nvModelLifecycleFixture'),
  );
  await page.clock.install();
});
afterEach(async () => {
  if (page) await page.close();
  expect(pageErrors).toEqual([]);
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

/** Controlled fetch responses test the shipped client in Chromium, not server protocol conformance. */
async function mountFixture(
  directive = 'nv:model.live.debounce.100ms',
  failTransport = false,
): Promise<void> {
  await page.evaluate(
    ({ directive, failTransport }) => {
      const root = document.querySelector('[data-nv-component]');
      const input = document.querySelector('#query');
      if (
        !(root instanceof HTMLElement) ||
        !(input instanceof HTMLInputElement)
      )
        throw new Error('Missing model fixture controls');
      input.removeAttribute('nv:model.live.debounce.100ms');
      input.setAttribute(directive, 'query');
      const responseHtml = root.innerHTML;
      const requests: ModelFixtureRequest[] = [];
      const errors: { message: string; code: string | null }[] = [];
      let state: Record<string, unknown> = { query: '' };
      const client = window.nvModelLifecycleFixture.createLiveClient({
        onError: (error) =>
          errors.push({
            message: error.message,
            code:
              typeof Reflect.get(error, 'code') === 'string'
                ? String(Reflect.get(error, 'code'))
                : null,
          }),
        fetch: async (url, options) => {
          const request = JSON.parse(String(options?.body)) as {
            requestId: string;
            revision: number;
            snapshot: string;
            updates: Record<string, unknown>;
          };
          requests.push({
            url: String(url),
            revision: request.revision,
            updates: request.updates,
          });
          if (failTransport) throw new Error('Model fixture transport failed');
          state = { ...state, ...request.updates };
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: request.requestId,
              component: {
                id: root.dataset['nvComponent'],
                name: 'editor',
                revision: request.revision + 1,
              },
              snapshot: request.snapshot,
              state,
              html: responseHtml,
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      window.nvModelSession = { client, requests, errors };
      client.mount();
    },
    { directive, failTransport },
  );
}
async function edit(value: string): Promise<void> {
  await page.evaluate((value) => {
    const input = document.querySelector('#query');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Missing model input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function metrics() {
  return page.evaluate(() => ({
    requests: window.nvModelSession.requests,
    errors: window.nvModelSession.errors,
  }));
}

describe('real-browser model lifecycle with controlled transport', () => {
  it.each(['control', 'component'])(
    'cancels a pending debounce after the %s detaches',
    async (target) => {
      await mountFixture();
      await edit('draft');
      await page.evaluate((target) => {
        const element = document.querySelector(
          target === 'control' ? '#query' : '[data-nv-component]',
        );
        if (!element) throw new Error('Missing removal target');
        element.remove();
      }, target);
      await page.clock.runFor(200);
      expect(await metrics()).toEqual({ requests: [], errors: [] });
    },
  );

  it.each(['nv:ignore', 'data-nv-island'])(
    'cancels pending debounce moved into %s under the same owner',
    async (boundary) => {
      await mountFixture();
      await edit('draft');
      await page.evaluate((boundary) => {
        const target = document.querySelector('#boundary');
        const input = document.querySelector('#query');
        if (!target || !input) throw new Error('Missing boundary fixture');
        target.setAttribute(boundary, '');
        target.append(input);
      }, boundary);
      await page.clock.runFor(200);
      expect(await metrics()).toEqual({ requests: [], errors: [] });
    },
  );

  it('cancels pending debounce when a model moves to another Live owner', async () => {
    await mountFixture();
    await edit('draft');
    await page.evaluate(() => {
      const root = document.querySelector('[data-nv-component]');
      const input = document.querySelector('#query');
      if (!(root instanceof HTMLElement) || !input)
        throw new Error('Missing owner fixture');
      const other = root.cloneNode(false) as HTMLElement;
      other.dataset['nvComponent'] = '22222222-2222-4222-8222-222222222222';
      document.querySelector('main')?.append(other);
      other.append(input);
    });
    await page.clock.runFor(200);
    expect(await metrics()).toEqual({ requests: [], errors: [] });
  });

  it('cancels disposed timers and remounts once with one new synchronization', async () => {
    await mountFixture();
    await edit('discarded');
    await page.evaluate(() => window.nvModelSession.client.dispose());
    await page.clock.runFor(200);
    expect(await metrics()).toEqual({ requests: [], errors: [] });
    await page.evaluate(() => {
      window.nvModelSession.client.mount();
      window.nvModelSession.client.mount();
    });
    await edit('after remount');
    await page.clock.runFor(200);
    expect(await metrics()).toEqual({
      requests: [
        {
          url: `${base}/live/editor/_sync`,
          revision: 0,
          updates: { query: 'after remount' },
        },
      ],
      errors: [],
    });
    expect(await page.locator('output').textContent()).toBe('after remount');
  });

  it('blocks pending synchronization and explicit actions for invalid numeric input, then recovers', async () => {
    await mountFixture('nv:model.number.live.debounce.100ms');
    await edit('2');
    await edit('invalid');
    await page.clock.runFor(200);
    const rejected = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!root) throw new Error('Missing model root');
      return window.nvModelSession.client.call(root, 'save').then(
        () => false,
        () => true,
      );
    });
    expect(rejected).toBe(true);
    expect(await metrics()).toEqual({
      requests: [],
      errors: [
        {
          code: 'DIRECTIVE',
          message: 'Numeric models require a complete finite decimal value',
        },
        {
          code: 'DIRECTIVE',
          message: 'Correct invalid model values before submitting',
        },
      ],
    });
    await edit('3');
    await page.clock.runFor(200);
    const result = await metrics();
    expect(result.requests).toEqual([
      { url: `${base}/live/editor/_sync`, revision: 0, updates: { query: 3 } },
    ]);
    expect(result.errors).toHaveLength(2);
    expect(await page.locator('output').textContent()).toBe('3');
  });

  it('reports a model transport failure exactly once and does not retry', async () => {
    await mountFixture('nv:model.live.debounce.100ms', true);
    await edit('draft');
    await page.clock.runFor(200);
    expect(await metrics()).toEqual({
      requests: [
        {
          url: `${base}/live/editor/_sync`,
          revision: 0,
          updates: { query: 'draft' },
        },
      ],
      errors: [
        {
          code: 'NETWORK',
          message:
            'Live request failed; reconcile server state before further actions',
        },
      ],
    });
    await page.clock.runFor(5000);
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).errors).toHaveLength(1);
  });
});
