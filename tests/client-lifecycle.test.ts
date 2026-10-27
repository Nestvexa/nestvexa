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

declare global {
  interface Window {
    nvLifecycleFixture: typeof import('../packages/client/dist/index.js');
  }
}

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
const html =
  '<!doctype html><html lang="en"><head><title>Live lifecycle fixture</title><script type="module" src="/fixture.js"></script></head><body><main><div data-nv-component="11111111-1111-4111-8111-111111111111" data-nv-name="counter" data-nv-snapshot="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" data-nv-state="{&quot;count&quot;:0}" data-nv-revision="0" data-nv-endpoint="/live/counter" data-nv-csrf="host-csrf-012345678901234567890123456789"><output nv:text="count">0</output><button type="button" nv:click="increment">Increase</button></div></main></body></html>';

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
          "import * as client from '/index.js'; window.nvLifecycleFixture = client;",
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
    throw new Error('Missing lifecycle fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvLifecycleFixture'));
});
afterEach(async () => {
  if (page) await page.close();
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe('real-browser Live client lifecycle', () => {
  it('mounts one client idempotently and emits a single request for one delegated click', async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      let calls = 0;
      const client = window.nvLifecycleFixture.createLiveClient({
        fetch: async (_url, options) => {
          calls++;
          const request = JSON.parse(String(options?.body)) as {
            requestId: string;
            revision: number;
            snapshot: string;
          };
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: request.requestId,
              component: {
                id: root.dataset['nvComponent'],
                name: 'counter',
                revision: request.revision + 1,
              },
              snapshot: request.snapshot,
              state: { count: calls },
              html: `<output nv:text="count">${calls}</output><button type="button" nv:click="increment">Increase</button>`,
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      client.mount();
      client.mount();
      const updated = new Promise<void>((resolve) =>
        root.addEventListener('nestvexa:updated', () => resolve(), {
          once: true,
        }),
      );
      root.querySelector('button')?.click();
      await updated;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      client.dispose();
      return {
        calls,
        value: root.querySelector('output')?.textContent,
        busy: root.getAttribute('aria-busy'),
      };
    });
    expect(result).toEqual({ calls: 1, value: '1', busy: null });
  });

  it('releases listeners on dispose and allows an explicit remount using the latest revision', async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      const revisions: number[] = [];
      const client = window.nvLifecycleFixture.createLiveClient({
        fetch: async (_url, options) => {
          const request = JSON.parse(String(options?.body)) as {
            requestId: string;
            revision: number;
            snapshot: string;
          };
          revisions.push(request.revision);
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: request.requestId,
              component: {
                id: root.dataset['nvComponent'],
                name: 'counter',
                revision: request.revision + 1,
              },
              snapshot: request.snapshot,
              state: { count: revisions.length },
              html: '<output nv:text="count"></output><button type="button" nv:click="increment">Increase</button>',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      client.mount();
      await client.call(root, 'increment');
      client.dispose();
      client.dispose();
      root.querySelector('button')?.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const callsWhileDisposed = revisions.length;
      const rejected = await client.call(root, 'increment').then(
        () => false,
        () => true,
      );
      client.mount();
      await client.call(root, 'increment');
      client.dispose();
      return {
        revisions,
        callsWhileDisposed,
        rejected,
        value: root.querySelector('output')?.textContent,
      };
    });
    expect(result).toEqual({
      revisions: [0, 1],
      callsWhileDisposed: 1,
      rejected: true,
      value: '2',
    });
  });

  it('aborts an in-flight request when its component is removed and suppresses queued actions', async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      let calls = 0;
      let aborted = 0;
      let errors = 0;
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const client = window.nvLifecycleFixture.createLiveClient({
        onError: () => {
          errors++;
        },
        fetch: (_url, options) => {
          calls++;
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                aborted++;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
            signalStarted?.();
          });
        },
      });
      client.mount();
      const first = client.call(root, 'increment').catch(() => undefined);
      const queued = client.call(root, 'increment').catch(() => undefined);
      await started;
      root.remove();
      await Promise.all([first, queued]);
      client.dispose();
      return { calls, aborted, errors };
    });
    expect(result).toEqual({ calls: 1, aborted: 1, errors: 0 });
  });

  it('aborts an in-flight request on disposal and releases the component marker for another client', async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      let calls = 0;
      let aborted = 0;
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const client = window.nvLifecycleFixture.createLiveClient({
        fetch: (_url, options) => {
          calls++;
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                aborted++;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
            signalStarted?.();
          });
        },
      });
      client.mount();
      const pending = client.call(root, 'increment').catch(() => undefined);
      await started;
      client.dispose();
      await pending;
      const replacement = window.nvLifecycleFixture.createLiveClient({
        fetch: async (_url, options) => {
          calls++;
          const request = JSON.parse(String(options?.body)) as {
            requestId: string;
            revision: number;
            snapshot: string;
          };
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: request.requestId,
              component: {
                id: root.dataset['nvComponent'],
                name: 'counter',
                revision: request.revision + 1,
              },
              snapshot: request.snapshot,
              state: { count: 1 },
              html: '<output nv:text="count"></output><button type="button" nv:click="increment">Increase</button>',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      replacement.mount();
      await replacement.call(root, 'increment');
      replacement.dispose();
      return {
        calls,
        aborted,
        value: root.querySelector('output')?.textContent,
      };
    });
    expect(result).toEqual({ calls: 2, aborted: 1, value: '1' });
  });

  it('allows only one active client to own a component even when separate clients mount the same document', async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      let calls = 0;
      const errors: string[] = [];
      const transport: typeof fetch = async (_url, options) => {
        calls++;
        const request = JSON.parse(String(options?.body)) as {
          requestId: string;
          revision: number;
          snapshot: string;
        };
        return new Response(
          JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: request.requestId,
            component: {
              id: root.dataset['nvComponent'],
              name: 'counter',
              revision: request.revision + 1,
            },
            snapshot: request.snapshot,
            state: { count: 1 },
            html: '<output nv:text="count"></output><button type="button" nv:click="increment">Increase</button>',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      };
      const first = window.nvLifecycleFixture.createLiveClient({
        fetch: transport,
        onError: (error) => errors.push(error.message),
      });
      const second = window.nvLifecycleFixture.createLiveClient({
        fetch: transport,
        onError: (error) => errors.push(error.message),
      });
      first.mount();
      try {
        second.mount();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'error');
      }
      const updated = new Promise<void>((resolve) =>
        root.addEventListener('nestvexa:updated', () => resolve(), {
          once: true,
        }),
      );
      root.querySelector('button')?.click();
      await updated;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      first.dispose();
      second.dispose();
      return {
        calls,
        errors,
        value: root.querySelector('output')?.textContent,
      };
    });
    expect(result.calls).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.value).toBe('1');
  });

  it('aborts requests when an explicitly scoped component root itself is detached', async () => {
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-nv-component]');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      let aborted = 0;
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const client = window.nvLifecycleFixture.createLiveClient({
        root,
        fetch: (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                aborted++;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
            signalStarted?.();
          }),
      });
      client.mount();
      const pending = client.call(root, 'increment').catch(() => undefined);
      await started;
      root.remove();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const abortedOnDetach = aborted;
      const callAfterDetach = client.call(root, 'increment').then(
        () => false,
        () => true,
      );
      client.dispose();
      await pending;
      const rejectedAfterDetach = await callAfterDetach;
      return { abortedOnDetach, rejectedAfterDetach };
    });
    expect(result).toEqual({ abortedOnDetach: 1, rejectedAfterDetach: true });
  });
});
