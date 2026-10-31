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
    nvInitSession: {
      client: import('../packages/client/dist/index.js').LiveClient;
      requests: {
        body: InitBody;
        action: string;
        hostReady: boolean;
        owner: Element;
        resolve(response: Response): void;
      }[];
      errors: string[];
      reply(index: number, status?: number, html?: string): void;
    };
  }
}

interface InitBody {
  requestId: string;
  revision: number;
  snapshot: string;
}
const initHtml =
  '<section id="initializer" nv:init="load"><output id="count" nv:text="count">0</output><button id="refresh" type="button" nv:click="refresh">Refresh</button></section>';
async function mountInit(
  options: {
    html?: string;
    limit?: number;
    count?: number;
    after?:
      | 'dispose'
      | 'remove'
      | 'ignore'
      | 'action'
      | 'modifier'
      | 'duplicate'
      | 'marker'
      | 'island';
  } = {},
): Promise<void> {
  await page.evaluate(
    ({ html, options }) => {
      const first = document.querySelector('[data-nv-component]');
      if (!first) throw new Error('Missing initialization fixture');
      first.id = 'parent';
      first.innerHTML = options.html ?? html;
      for (let index = 1; index < (options.count ?? 1); index++) {
        const other = first.cloneNode(true) as Element;
        other.id = `other-${index}`;
        other.setAttribute('data-nv-component', `component-${index}`);
        other.setAttribute('data-nv-name', `other-${index}`);
        other.setAttribute('data-nv-endpoint', `/live/other-${index}`);
        document.querySelector('main')?.append(other);
      }
      const requests: Window['nvInitSession']['requests'] = [];
      const errors: string[] = [];
      let hostReady = false;
      const client = window.nvLifecycleFixture.createLiveClient({
        ...(options.limit === undefined
          ? {}
          : { maxInitializations: options.limit }),
        onError(error) {
          errors.push(error.message);
        },
        fetch(url, init) {
          const owner = [
            ...document.querySelectorAll('[data-nv-component]'),
          ].find((element) =>
            String(url).startsWith(
              new URL(
                element.getAttribute('data-nv-endpoint') ?? '',
                location.href,
              ).href + '/',
            ),
          );
          if (!owner) throw new Error('Missing request owner');
          const body = JSON.parse(String(init?.body)) as InitBody;
          return new Promise<Response>((resolve) =>
            requests.push({
              body,
              owner,
              action: String(url).split('/').at(-1) ?? '',
              hostReady,
              resolve,
            }),
          );
        },
      });
      window.nvInitSession = {
        client,
        requests,
        errors,
        reply(index, status = 200, fragment = html) {
          const request = requests[index];
          if (!request) throw new Error('Missing initialization request');
          request.resolve(
            new Response(
              JSON.stringify({
                protocol: 'nestvexa-live/1',
                requestId: request.body.requestId,
                component: {
                  id: request.owner.getAttribute('data-nv-component'),
                  name: request.owner.getAttribute('data-nv-name'),
                  revision: request.body.revision + 1,
                },
                snapshot: request.body.snapshot,
                state: { count: request.body.revision + 1 },
                html: fragment,
              }),
              { status, headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      };
      client.mount();
      client.mount();
      hostReady = true;
      const target = first.querySelector('#initializer');
      if (options.after === 'dispose') client.dispose();
      else if (options.after === 'remove') target?.remove();
      else if (options.after === 'ignore')
        target?.setAttribute('nv:ignore', '');
      else if (options.after === 'action')
        target?.setAttribute('nv:init', 'different');
      else if (options.after === 'modifier')
        target?.setAttribute('nv:init.once', 'load');
      else if (options.after === 'duplicate' && target)
        first.append(target.cloneNode(true));
      else if (options.after === 'marker')
        first.setAttribute('data-nv-revision', '99');
      else if (options.after === 'island')
        first.setAttribute('data-nv-island', 'owned-by-another-renderer');
    },
    { html: initHtml, options },
  );
}
async function initState() {
  return page.evaluate(() => ({
    actions: window.nvInitSession.requests.map((request) => request.action),
    revisions: window.nvInitSession.requests.map(
      (request) => request.body.revision,
    ),
    errors: window.nvInitSession.errors,
  }));
}
async function initReply(
  index: number,
  status = 200,
  html?: string,
): Promise<void> {
  await page.evaluate(
    ({ index, status, html }) =>
      window.nvInitSession.reply(index, status, html),
    { index, status, html },
  );
  await page.waitForFunction(
    ({ index, status }) =>
      status === 200
        ? Number(
            window.nvInitSession.requests[index]?.owner.getAttribute(
              'data-nv-revision',
            ),
          ) > (window.nvInitSession.requests[index]?.body.revision ?? Infinity)
        : window.nvInitSession.errors.length > 0,
    { index, status },
  );
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
      'initialization',
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
      'observers',
      'presentation',
      'url-state',
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
  if (page) {
    await page.evaluate(() => window.nvInitSession?.client.dispose());
    await page.close();
  }
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe('automatic initialization in actual Chromium with controlled transport', () => {
  it('initializes once after registration, then retains the attempt across ordinary and replaced fragments', async () => {
    await mountInit();
    expect((await initState()).actions).toEqual(['load']);
    await initReply(0);
    await page.locator('#refresh').click();
    await initReply(
      1,
      200,
      initHtml.replace('<section ', '<section nv:replace.self '),
    );
    expect(await initState()).toEqual({
      actions: ['load', 'refresh'],
      revisions: [0, 1],
      errors: [],
    });
  });
  it('runs only after the synchronous host mounting turn completes', async () => {
    await mountInit();
    expect((await initState()).actions).toEqual(['load']);
    expect(
      await page.evaluate(() => window.nvInitSession.requests[0]?.hostReady),
    ).toBe(true);
    expect(await page.locator('#parent').getAttribute('aria-busy')).toBe(
      'true',
    );
    await initReply(0);
    expect(await page.locator('#count').textContent()).toBe('1');
  });
  it.each([
    'dispose',
    'remove',
    'ignore',
    'action',
    'modifier',
    'duplicate',
    'marker',
    'island',
  ] as const)('does not dispatch after pre-microtask %s', async (after) => {
    await mountInit({ after });
    expect((await initState()).actions).toEqual([]);
  });
  it('does not retry a rejected initialization when another action renders its directive again', async () => {
    await mountInit();
    await initReply(0, 403);
    await page.locator('#refresh').click();
    await initReply(1);
    expect((await initState()).actions).toEqual(['load', 'refresh']);
    expect((await initState()).errors).toHaveLength(1);
  });
  it('initializes when the first declaration arrives in a later valid server fragment', async () => {
    await mountInit({ html: initHtml.replace(' nv:init="load"', '') });
    expect((await initState()).actions).toEqual([]);
    await page.locator('#refresh').click();
    await initReply(0);
    await page.waitForFunction(
      () => window.nvInitSession.requests.length === 2,
    );
    expect((await initState()).actions).toEqual(['refresh', 'load']);
    expect((await initState()).revisions).toEqual([0, 1]);
    await initReply(1);
    expect((await initState()).actions).toEqual(['refresh', 'load']);
  });
  it('does not restore a canceled attempt when a later fragment introduces the declaration again', async () => {
    await mountInit({ after: 'remove' });
    await page.evaluate(() => {
      const root = document.querySelector('#parent');
      if (!root) throw new Error('Missing initializer owner');
      void window.nvInitSession.client.call(root, 'refresh');
    });
    await initReply(0);
    expect((await initState()).actions).toEqual(['refresh']);
  });
  it('reruns only after an explicit disposal/remount, using the current revision', async () => {
    await mountInit();
    await initReply(0);
    await page.evaluate(() => {
      window.nvInitSession.client.dispose();
      window.nvInitSession.client.mount();
    });
    await initReply(1);
    expect((await initState()).revisions).toEqual([0, 1]);
  });
  it('bounds automatic requests across different components', async () => {
    await mountInit({ count: 3, limit: 2 });
    expect((await initState()).actions).toEqual(['load', 'load']);
    expect((await initState()).errors).toEqual([
      'Automatic initialization capacity reached',
    ]);
  });
  it('defaults to a maximum of 64 attempts per client lifecycle', async () => {
    await mountInit({ count: 65 });
    expect((await initState()).actions).toHaveLength(64);
    expect((await initState()).errors).toEqual([
      'Automatic initialization capacity reached',
    ]);
  });
  it.each([0, -1, 0.5, NaN, Infinity, 1001])(
    'rejects invalid initialization capacity %s',
    async (limit) => {
      const message = await page.evaluate((limit) => {
        try {
          window.nvLifecycleFixture.createLiveClient({
            maxInitializations: limit,
          });
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
      }, limit);
      expect(message).toContain('maxInitializations');
    },
  );
  it.each([
    '<section nv:init="load()"></section>',
    '<section nv:init.once="load"></section>',
    '<section nv:init="load"><p nv:init="load"></p></section>',
    '<button nv:init="load" nv:click="refresh" nv:confirm="Continue?">Bad combination</button>',
  ])('rejects invalid markup before automatic execution', async (html) => {
    await mountInit({ html });
    expect((await initState()).actions).toEqual([]);
    expect((await initState()).errors).toHaveLength(1);
  });
  it('ignores initializers owned by whole-ignore and framework boundaries', async () => {
    await mountInit({
      html: '<aside nv:ignore><span nv:init="load"></span></aside><div data-nv-island="chart"><span nv:init="load"></span></div>',
    });
    expect((await initState()).actions).toEqual([]);
  });
  it('runs a newly inserted component independently of a retained parent', async () => {
    await mountInit();
    await initReply(0);
    await page.evaluate(() => {
      const parent = document.getElementById('parent');
      if (!parent) throw new Error('Missing parent');
      const child = parent.cloneNode(true) as Element;
      child.id = 'child';
      child.setAttribute('data-nv-component', 'child-component');
      child.setAttribute('data-nv-name', 'child');
      child.setAttribute('data-nv-endpoint', '/live/child');
      child.setAttribute('data-nv-revision', '0');
      parent.append(child);
    });
    await page.waitForFunction(
      () => window.nvInitSession.requests.length === 2,
    );
    await initReply(1);
    expect((await initState()).actions).toEqual(['load', 'load']);
  });
});

describe('visible and idle initialization in actual Chromium', () => {
  const visibleHtml = initHtml
    .replace('nv:init="load"', 'nv:init.visible="load"')
    .replace(
      '<section ',
      '<section style="position:absolute;top:2000px;width:200px;height:100px" ',
    );
  const idleHtml = initHtml.replace('nv:init="load"', 'nv:init.idle="load"');
  it('waits for actual viewport entry and preserves its attempt after morphing', async () => {
    await mountInit({ html: visibleHtml });
    expect((await initState()).actions).toEqual([]);
    await page.locator('#initializer').scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () => window.nvInitSession.requests.length === 1,
    );
    expect((await initState()).actions).toEqual(['load']);
    expect(
      await page.evaluate(() => window.nvInitSession.requests[0]?.hostReady),
    ).toBe(true);
    await initReply(0, 200, visibleHtml);
    await page.locator('#initializer').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.nvInitSession.client.mount());
    expect((await initState()).actions).toEqual(['load']);
  });
  it('does not initialize a geometrically intersecting element until its document becomes visible', async () => {
    await page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      }),
    );
    await mountInit({
      html: initHtml.replace('nv:init="load"', 'nv:init.visible="load"'),
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const target = document.getElementById('initializer');
          if (!target) throw new Error('Missing visible initializer');
          const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(target);
        }),
    );
    expect((await initState()).actions).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(
      () => window.nvInitSession.requests.length === 1,
    );
    expect((await initState()).actions).toEqual(['load']);
  });
  it.each([
    'dispose',
    'remove',
    'ignore',
    'action',
    'modifier',
    'duplicate',
    'marker',
    'island',
  ] as const)(
    'cancels pending visibility work after %s without reclaiming the attempt',
    async (after) => {
      await mountInit({ html: visibleHtml, after });
      await page.evaluate(() =>
        document
          .getElementById('initializer')
          ?.setAttribute(
            'style',
            'position:absolute;top:10px;width:200px;height:100px',
          ),
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect((await initState()).actions).toEqual([]);
    },
  );
  it('does not restore a removed visible attempt when later markup declares it again', async () => {
    await mountInit({ html: visibleHtml, after: 'remove' });
    await page.evaluate(() => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing initialization root');
      void window.nvInitSession.client.call(root, 'refresh');
    });
    await initReply(0, 200, visibleHtml);
    await page.locator('#initializer').scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect((await initState()).actions).toEqual(['refresh']);
  });
  it('uses the native idle callback after synchronous host mounting', async () => {
    await mountInit({ html: idleHtml });
    await page.waitForFunction(
      () => window.nvInitSession.requests.length === 1,
    );
    expect((await initState()).actions).toEqual(['load']);
    expect(
      await page.evaluate(() => window.nvInitSession.requests[0]?.hostReady),
    ).toBe(true);
    await initReply(0, 200, idleHtml);
    expect((await initState()).actions).toEqual(['load']);
  });
  it('falls back to a bounded 100ms timer when idle callbacks are unavailable', async () => {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
    await page.evaluate(() =>
      Object.defineProperty(window, 'requestIdleCallback', {
        configurable: true,
        value: undefined,
      }),
    );
    await mountInit({ html: idleHtml });
    expect((await initState()).actions).toEqual([]);
    await page.clock.runFor(99);
    expect((await initState()).actions).toEqual([]);
    await page.clock.runFor(1);
    expect((await initState()).actions).toEqual(['load']);
    expect(
      await page.evaluate(() => window.nvInitSession.requests[0]?.hostReady),
    ).toBe(true);
  });
  it.each([
    'dispose',
    'remove',
    'ignore',
    'action',
    'modifier',
    'duplicate',
    'marker',
    'island',
  ] as const)('cancels pending idle fallback work after %s', async (after) => {
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
    await page.evaluate(() =>
      Object.defineProperty(window, 'requestIdleCallback', {
        configurable: true,
        value: undefined,
      }),
    );
    await mountInit({ html: idleHtml, after });
    await page.clock.runFor(1000);
    expect((await initState()).actions).toEqual([]);
  });
  it('counts all initialization timing variants against one shared component limit', async () => {
    await mountInit({ html: visibleHtml, count: 3, limit: 2 });
    expect((await initState()).actions).toEqual([]);
    expect((await initState()).errors).toEqual([
      'Automatic initialization capacity reached',
    ]);
    await page.evaluate(() => {
      for (const target of document.querySelectorAll('[nv\\:init\\.visible]'))
        target.setAttribute(
          'style',
          'position:absolute;top:10px;width:200px;height:100px',
        );
    });
    await page.waitForFunction(
      () => window.nvInitSession.requests.length === 2,
    );
    expect((await initState()).actions).toEqual(['load', 'load']);
  });
  it.each([
    '<section nv:init="load" nv:init.visible="load"></section>',
    '<section nv:init.visible="load"><p nv:init.idle="load"></p></section>',
    '<button nv:init.visible="load" nv:click="refresh" nv:confirm="Continue?">Bad combination</button>',
    '<section nv:init.visible.idle="load"></section>',
  ])(
    'rejects multiple timings, unsupported modifiers and confirmation bypasses',
    async (html) => {
      await mountInit({ html });
      expect((await initState()).actions).toEqual([]);
      expect((await initState()).errors).toHaveLength(1);
    },
  );
  it('fails explicitly when visible initialization has no native observer capability', async () => {
    await page.evaluate(() =>
      Object.defineProperty(window, 'IntersectionObserver', {
        configurable: true,
        value: undefined,
      }),
    );
    await mountInit({ html: visibleHtml });
    expect((await initState()).actions).toEqual([]);
    expect((await initState()).errors).toEqual([
      'nv:init.visible requires IntersectionObserver support',
    ]);
  });
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
