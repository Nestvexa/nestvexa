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

interface RequestBody {
  requestId: string;
  revision: number;
  snapshot: string;
  updates: Record<string, unknown>;
}
interface TaskResult {
  ok: boolean;
  code: string | null;
}
interface TransportRequest {
  url: string;
  body: RequestBody;
  signal: AbortSignal | null;
  resolve(response: Response): void;
  reject(error: Error): void;
  cancelled: number;
}
interface Reply {
  status?: number;
  mime?: string | null;
  declaredLength?: string;
  raw?: string;
  state?: Record<string, unknown>;
  html?: string;
  mode?:
    | 'hang'
    | 'hang-cancel'
    | 'invalid-utf8'
    | 'unicode-overflow'
    | 'ascii-overflow'
    | 'exact-limit'
    | 'split-unicode'
    | 'reader-error'
    | 'empty';
}
declare global {
  interface Window {
    nvTransportFixture: typeof import('../packages/client/dist/index.js');
    nvTransportSession: {
      client: ReturnType<
        typeof import('../packages/client/dist/index.js').createLiveClient
      >;
      requests: TransportRequest[];
      results: (TaskResult | null)[];
      errors: { code: string | null; message: string }[];
      reply(index: number, spec?: Reply): void;
    };
  }
}
let browser: Browser;
let server: Server;
let page: Page;
let base: string;
let pageErrors: string[];

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Bounded client transport fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; window.nvTransportFixture = client;",
        );
      return;
    }
    if (!/^\/[a-z][a-z0-9-]*\.js$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL(`../packages/client/dist/${pathname.slice(1)}`, import.meta.url),
      'utf8',
    ).then(
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
    throw new Error('Missing transport fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvTransportFixture'));
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvTransportSession?.client.dispose());
    await page.close();
  }
  expect(pageErrors).toEqual([]);
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

interface MountOptions {
  timeout?: number;
  second?: boolean;
  nested?: boolean;
  live?: boolean;
}
/** Actual Chromium with deliberately controlled fetch/streams; not Nest protocol conformance. */
async function mount(options: MountOptions = { timeout: 100 }): Promise<void> {
  await page.evaluate(({ timeout, second, nested, live }) => {
    const html = (name: string) =>
      `<form id="${name}-form" nv:submit="save"><label for="${name}-edit">Query</label><input id="${name}-edit" nv:model${live ? '.live.debounce.25ms' : ''}="query" value="initial"><button type="submit">Save</button></form><button id="${name}-slow" type="button" nv:click="slow" nv:loading.attr="disabled" nv:target="slow">Slow</button><span id="${name}-loading" nv:loading="" nv:target="slow" hidden>Pending</span><output id="${name}-count" nv:text="count">0</output><output id="${name}-query" nv:text="query">initial</output>`;
    const createRoot = (name: string, number: number) => {
      const element = document.createElement('section');
      element.id = name;
      for (const [key, value] of Object.entries({
        'data-nv-component': `${number}1111111-1111-4111-8111-111111111111`,
        'data-nv-name': name,
        'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'data-nv-revision': '0',
        'data-nv-endpoint': `/live/${name}`,
        'data-nv-csrf': 'fixture-csrf-012345678901234567890123456789',
        'data-nv-state': JSON.stringify({ query: 'initial', count: 0 }),
      }))
        element.setAttribute(key, value);
      element.innerHTML = html(name);
      return element;
    };
    const parent = createRoot('parent', 1);
    document.querySelector('main')?.append(parent);
    if (second || nested) {
      const other = createRoot('other', 2);
      (nested ? parent : document.querySelector('main'))?.append(other);
    }
    const requests: TransportRequest[] = [];
    const results: (TaskResult | null)[] = [];
    const errors: { code: string | null; message: string }[] = [];
    const client = window.nvTransportFixture.createLiveClient({
      ...(timeout === undefined ? {} : { requestTimeoutMs: timeout }),
      onError(error) {
        errors.push({
          code:
            typeof Reflect.get(error, 'code') === 'string'
              ? String(Reflect.get(error, 'code'))
              : null,
          message: error.message,
        });
      },
      fetch(url, init) {
        return new Promise<Response>((resolve, reject) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)) as RequestBody,
            signal: init?.signal ?? null,
            resolve,
            reject,
            cancelled: 0,
          });
          // Deliberately ignore abort here: the client deadline must settle independently.
        });
      },
    });
    window.nvTransportSession = {
      client,
      requests,
      results,
      errors,
      reply(index, spec = {}) {
        const request = requests[index];
        if (!request) throw new Error('Missing pending transport request');
        const name = new URL(request.url, location.href).pathname
          .split('/')
          .at(-2);
        const root = name ? document.getElementById(name) : null;
        if (!root || !name) throw new Error('Missing response owner');
        const envelope = {
          protocol: 'nestvexa-live/1',
          requestId: request.body.requestId,
          component: {
            id: root.getAttribute('data-nv-component'),
            name,
            revision: request.body.revision + 1,
          },
          snapshot: request.body.snapshot,
          state: spec.state ?? {
            query: 'server',
            count: request.body.revision + 1,
          },
          html: spec.html ?? html(name),
          padding: '',
        };
        const encoder = new TextEncoder();
        if (spec.mode === 'unicode-overflow')
          envelope.padding = '€'.repeat(1_000_000);
        if (spec.mode === 'ascii-overflow')
          envelope.padding = 'x'.repeat(3_000_000);
        if (spec.mode === 'exact-limit')
          envelope.padding = 'x'.repeat(
            2_097_152 - encoder.encode(JSON.stringify(envelope)).length,
          );
        let bytes = encoder.encode(spec.raw ?? JSON.stringify(envelope));
        if (spec.mode === 'split-unicode') {
          envelope.state = {
            query: 'مرحبا € 😀',
            count: request.body.revision + 1,
          };
          bytes = encoder.encode(JSON.stringify(envelope));
        }
        const headers = new Headers();
        if (spec.mime !== null)
          headers.set(
            'content-type',
            spec.mime ?? 'application/json; charset=utf-8',
          );
        if (spec.declaredLength !== undefined)
          headers.set('content-length', spec.declaredLength);
        if (spec.mode === 'empty') {
          request.resolve(
            new Response(null, { status: spec.status ?? 200, headers }),
          );
          return;
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (spec.mode === 'reader-error') {
              controller.error(new Error('private reader debug'));
              return;
            }
            if (spec.mode === 'hang' || spec.mode === 'hang-cancel') {
              controller.enqueue(encoder.encode('{"protocol":'));
              return;
            }
            if (spec.mode === 'invalid-utf8')
              controller.enqueue(new Uint8Array([0xc3, 0x28]));
            else if (spec.mode === 'split-unicode') {
              for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
            } else {
              for (let offset = 0; offset < bytes.length; offset += 65_536)
                controller.enqueue(bytes.subarray(offset, offset + 65_536));
            }
            controller.close();
          },
          cancel(): void | Promise<void> {
            request.cancelled++;
            if (spec.mode === 'hang-cancel') return new Promise<void>(() => {});
          },
        });
        request.resolve(
          new Response(stream, { status: spec.status ?? 200, headers }),
        );
      },
    };
    client.mount();
  }, options);
}
async function start(action = 'slow', selector = '#parent'): Promise<number> {
  return page.evaluate(
    ({ action, selector }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error('Missing target');
      const session = window.nvTransportSession;
      const index = session.results.length;
      session.results.push(null);
      void session.client.call(root, action).then(
        () => {
          session.results[index] = { ok: true, code: null };
        },
        (error: unknown) => {
          session.results[index] = {
            ok: false,
            code:
              error instanceof Error
                ? String(Reflect.get(error, 'code'))
                : null,
          };
        },
      );
      return index;
    },
    { action, selector },
  );
}
async function result(index: number): Promise<TaskResult | null> {
  return page.evaluate(
    (index) => window.nvTransportSession.results[index] ?? null,
    index,
  );
}
async function reply(index: number, spec: Reply = {}): Promise<void> {
  await page.evaluate(
    ({ index, spec }) => window.nvTransportSession.reply(index, spec),
    { index, spec },
  );
  await page.clock.runFor(0);
}
async function metrics() {
  return page.evaluate(() => ({
    requests: window.nvTransportSession.requests.map((request) => ({
      revision: request.body.revision,
      snapshot: request.body.snapshot,
      aborted: request.signal?.aborted ?? false,
      cancelled: request.cancelled,
    })),
    errors: window.nvTransportSession.errors,
  }));
}

describe('bounded browser request lifecycle', () => {
  it.each([0, -1, 0.5, NaN, Infinity, 300_001])(
    'rejects invalid request deadline %s',
    async (timeout) => {
      const code = await page.evaluate((timeout) => {
        try {
          window.nvTransportFixture.createLiveClient({
            requestTimeoutMs: timeout,
          });
          return null;
        } catch (error) {
          return error instanceof Error
            ? String(Reflect.get(error, 'code'))
            : 'UNKNOWN';
        }
      }, timeout);
      expect(code).toBe('DIRECTIVE');
    },
  );

  it('uses the bounded 30 second default', async () => {
    await mount({});
    const task = await start();
    await page.clock.runFor(29_999);
    expect(await result(task)).toBeNull();
    await page.clock.runFor(1);
    expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    expect((await metrics()).requests).toHaveLength(1);
  });

  it('bounds an uncooperative fetch and drops queued requests without retry', async () => {
    await mount();
    const first = await start();
    const second = await start('save');
    const third = await start('save');
    await page.clock.runFor(100);
    for (const task of [first, second, third])
      expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    const state = await metrics();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.aborted).toBe(true);
    expect(state.errors.map((error) => error.code)).toEqual(['TIMEOUT']);
    expect(await page.locator('#parent').getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(await page.locator('#parent-slow').isDisabled()).toBe(false);
    expect(await page.locator('#parent-loading').isHidden()).toBe(true);
    await page.clock.runFor(500_000);
    expect((await metrics()).requests).toHaveLength(1);
  });

  it('includes response body consumption in the original deadline and cancels a stalled reader', async () => {
    await mount();
    const task = await start();
    await page.clock.runFor(80);
    await reply(0, { mode: 'hang' });
    await page.clock.runFor(19);
    expect(await result(task)).toBeNull();
    await page.clock.runFor(1);
    expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    expect((await metrics()).requests[0]).toMatchObject({
      aborted: true,
      cancelled: 1,
    });
  });

  it('starts each queued deadline at dispatch, advances revisions and clears successful timers', async () => {
    await mount();
    const first = await start();
    const second = await start('save');
    await page.clock.runFor(90);
    await reply(0);
    expect(await result(first)).toEqual({ ok: true, code: null });
    await page.clock.runFor(20);
    expect(await result(second)).toBeNull();
    expect(
      (await metrics()).requests.map((request) => request.revision),
    ).toEqual([0, 1]);
    await reply(1);
    expect(await result(second)).toEqual({ ok: true, code: null });
    await page.clock.runFor(500);
    expect((await metrics()).errors).toEqual([]);
    expect(await page.locator('#parent').getAttribute('data-nv-revision')).toBe(
      '2',
    );
  });

  it('does not wait for an underlying stream cancellation callback to settle', async () => {
    await mount();
    const task = await start();
    await reply(0, { mode: 'hang-cancel' });
    await page.clock.runFor(100);
    expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    expect((await metrics()).requests[0]?.cancelled).toBe(1);
    expect(await page.locator('#parent').getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it('preserves local state access and enhanced form prevention while transport is suspended', async () => {
    await mount({ timeout: 100, live: true });
    const task = await start();
    await page.locator('#parent-edit').fill('unacknowledged draft');
    await page.clock.runFor(100);
    expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    const local = await page.evaluate(() => {
      const root = document.getElementById('parent');
      const form = document.getElementById('parent-form');
      if (!root || !form) throw new Error('Missing local state fixture');
      const client = window.nvTransportSession.client;
      const saved = client.get(root, 'query');
      client.set(root, 'query', 'salvaged locally');
      const submit = new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
      });
      form.dispatchEvent(submit);
      return {
        saved,
        updated: client.get(root, 'query'),
        prevented: submit.defaultPrevented,
      };
    });
    expect(local).toEqual({
      saved: 'unacknowledged draft',
      updated: 'salvaged locally',
      prevented: true,
    });
    await page.locator('#parent-slow').click();
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).errors.map((error) => error.code)).toEqual([
      'TIMEOUT',
    ]);
  });

  it('does not let a late fetch completion mutate the failed registration', async () => {
    await mount();
    const task = await start();
    await page.clock.runFor(100);
    expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    await reply(0, { html: '<p id="late">Late effect</p>' });
    expect(await page.locator('#late').count()).toBe(0);
    expect(await page.locator('#parent').getAttribute('data-nv-revision')).toBe(
      '0',
    );
    expect((await metrics()).errors.map((error) => error.code)).toEqual([
      'TIMEOUT',
    ]);
  });

  it('requires explicit disposal and authoritative marker reconciliation before another request', async () => {
    await mount();
    const failed = await start();
    await page.clock.runFor(100);
    expect(await result(failed)).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(await result(await start('save'))).toEqual({
      ok: false,
      code: 'TIMEOUT',
    });
    await page.evaluate(() => {
      const session = window.nvTransportSession;
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing authoritative root');
      session.client.dispose();
      root.setAttribute('data-nv-revision', '1');
      root.setAttribute(
        'data-nv-snapshot',
        'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      );
      root.setAttribute(
        'data-nv-state',
        JSON.stringify({ query: 'reconciled', count: 1 }),
      );
      session.client.mount();
    });
    const next = await start('save');
    expect((await metrics()).requests[1]).toMatchObject({
      revision: 1,
      snapshot: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    await reply(1);
    expect(await result(next)).toEqual({ ok: true, code: null });
  });

  it('isolates uncertainty from an independent component', async () => {
    await mount({ timeout: 100, second: true });
    const first = await start();
    await page.clock.runFor(50);
    const other = await start('slow', '#other');
    await page.clock.runFor(50);
    expect(await result(first)).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(await result(other)).toBeNull();
    await reply(1);
    expect(await result(other)).toEqual({ ok: true, code: null });
    expect(await page.locator('#other-count').textContent()).toBe('1');
    expect((await metrics()).errors.map((error) => error.code)).toEqual([
      'TIMEOUT',
    ]);
  });

  it('propagates ancestor uncertainty to nested pending requests without duplicate diagnostics', async () => {
    await mount({ timeout: 100, nested: true });
    const parent = await start();
    await page.clock.runFor(40);
    const child = await start('slow', '#other');
    const childQueued = await start('save', '#other');
    await page.clock.runFor(60);
    for (const task of [parent, child, childQueued])
      expect(await result(task)).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(
      (await metrics()).requests.map((request) => request.aborted),
    ).toEqual([true, true]);
    expect((await metrics()).errors.map((error) => error.code)).toEqual([
      'TIMEOUT',
    ]);
    expect(await page.locator('#other').getAttribute('aria-busy')).toBe(
      'false',
    );
    await reply(1, { html: '<p id="late-child">Late nested response</p>' });
    expect(await page.locator('#late-child').count()).toBe(0);
  });

  it('does not commit an already-resolving child response after ancestor uncertainty', async () => {
    await mount({ timeout: 100, nested: true });
    const parent = await start();
    const child = await start('slow', '#other');
    await page.evaluate(() => {
      const nested = document.getElementById('other');
      if (!nested) throw new Error('Missing nested transport fixture');
      nested.addEventListener('nestvexa:updated', () =>
        nested.setAttribute('data-late-update', 'yes'),
      );
      const session = window.nvTransportSession;
      // Let the child's successful body race the parent's failure in the same
      // browser turn, after fetch has resolved but before invoke can commit.
      session.reply(1);
      queueMicrotask(() =>
        session.requests[0]?.reject(new Error('parent connection failed')),
      );
    });
    await page.clock.runFor(0);
    expect(await result(parent)).toEqual({ ok: false, code: 'NETWORK' });
    expect(await result(child)).toEqual({ ok: false, code: 'NETWORK' });
    expect(await page.locator('#other').getAttribute('data-nv-revision')).toBe(
      '0',
    );
    expect(await page.locator('#other-count').textContent()).toBe('0');
    expect(
      await page.locator('#other').getAttribute('data-late-update'),
    ).toBeNull();
    expect((await metrics()).errors.map((error) => error.code)).toEqual([
      'NETWORK',
    ]);
  });

  it.each(['unicode-overflow', 'ascii-overflow'] as const)(
    'bounds decoded bytes for %s before committing state',
    async (mode) => {
      await mount();
      const task = await start();
      await reply(0, { mode });
      expect(await result(task)).toEqual({ ok: false, code: 'RESPONSE' });
      expect((await metrics()).requests[0]?.cancelled).toBe(1);
      expect(
        await page.locator('#parent').getAttribute('data-nv-revision'),
      ).toBe('0');
      expect(await page.locator('#parent-count').textContent()).toBe('0');
      expect(await result(await start('save'))).toEqual({
        ok: false,
        code: 'RESPONSE',
      });
      expect((await metrics()).requests).toHaveLength(1);
    },
  );

  it('does not trust understated Content-Length', async () => {
    await mount();
    const task = await start();
    await reply(0, { mode: 'ascii-overflow', declaredLength: '1' });
    expect(await result(task)).toEqual({ ok: false, code: 'RESPONSE' });
    expect((await metrics()).requests[0]?.cancelled).toBe(1);
  });

  it('rejects an oversized declared body before reading it', async () => {
    await mount();
    const task = await start();
    await reply(0, { mode: 'hang', declaredLength: '2097153' });
    expect(await result(task)).toEqual({ ok: false, code: 'RESPONSE' });
    expect((await metrics()).requests[0]?.cancelled).toBe(1);
  });

  it('accepts exactly the response byte cap and does not leak its deadline', async () => {
    await mount();
    const task = await start();
    await reply(0, { mode: 'exact-limit' });
    expect(await result(task)).toEqual({ ok: true, code: null });
    await page.clock.runFor(1000);
    expect((await metrics()).errors).toEqual([]);
  });

  it('decodes split UTF-8 multibyte characters correctly', async () => {
    await mount();
    const task = await start();
    await reply(0, { mode: 'split-unicode' });
    expect(await result(task)).toEqual({ ok: true, code: null });
    expect(await page.locator('#parent-query').textContent()).toBe(
      'مرحبا € 😀',
    );
  });

  it.each([
    { label: 'malformed UTF-8', mode: 'invalid-utf8' as const },
    { label: 'empty body', mode: 'empty' as const },
    { label: 'failed body reader', mode: 'reader-error' as const },
    { label: 'invalid JSON', raw: '<html>private debug response</html>' },
    { label: 'JSON substring MIME', mime: 'text/xapplication/json' },
    { label: 'missing JSON MIME', mime: null },
  ])(
    'rejects $label without exposing body text or dispatching queued work',
    async (spec) => {
      await mount();
      const task = await start();
      const queued = await start('save');
      await reply(0, spec);
      expect(await result(task)).toEqual({ ok: false, code: 'RESPONSE' });
      expect(await result(queued)).toEqual({ ok: false, code: 'RESPONSE' });
      const state = await metrics();
      expect(state.requests).toHaveLength(1);
      expect(state.errors.map((error) => error.code)).toEqual(['RESPONSE']);
      expect(state.errors[0]?.message).not.toContain('private debug response');
    },
  );

  it.each([408, 409, 410, 500, 502, 503])(
    'requires reconciliation after HTTP %s without reading error payloads',
    async (status) => {
      await mount();
      const task = await start();
      const queued = await start('save');
      await reply(0, { status, mode: 'hang' });
      expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
      expect(await result(queued)).toEqual({ ok: false, code: 'HTTP' });
      expect((await metrics()).requests).toHaveLength(1);
      expect((await metrics()).requests[0]?.cancelled).toBe(1);
      expect((await metrics()).errors.map((error) => error.code)).toEqual([
        'HTTP',
      ]);
    },
  );

  it('keeps a recoverable validation rejection available for an explicit correction', async () => {
    await mount();
    const task = await start();
    await reply(0, { status: 422, raw: '{"code":"INVALID_STATE_UPDATE"}' });
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await page.locator('#parent-edit').fill('corrected');
    const next = await start('save');
    expect(
      (await metrics()).requests.map((request) => request.revision),
    ).toEqual([0, 0]);
    await reply(1, { state: { query: 'corrected', count: 1 } });
    expect(await result(next)).toEqual({ ok: true, code: null });
    expect(await page.locator('#parent-query').textContent()).toBe('corrected');
  });

  it('reports a native transport rejection once with a redacted stable code', async () => {
    await mount();
    await page.locator('#parent-slow').click();
    await page.evaluate(() =>
      window.nvTransportSession.requests[0]?.reject(
        new Error('private-cookie-and-response-debug'),
      ),
    );
    await page.clock.runFor(0);
    const state = await metrics();
    expect(state.errors.map((error) => error.code)).toEqual(['NETWORK']);
    expect(state.errors[0]?.message).not.toContain(
      'private-cookie-and-response-debug',
    );
    await page.locator('#parent-slow').click();
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).errors).toHaveLength(1);
  });

  it.each(['dispose', 'remove'] as const)(
    'settles an uncooperative active request promptly on %s',
    async (mode) => {
      await mount();
      const task = await start();
      const queued = await start('save');
      await page.evaluate((mode) => {
        if (mode === 'dispose') window.nvTransportSession.client.dispose();
        else document.getElementById('parent')?.remove();
      }, mode);
      await page.clock.runFor(0);
      expect(await result(task)).toEqual({ ok: true, code: null });
      expect(await result(queued)).toEqual({ ok: true, code: null });
      expect((await metrics()).requests).toHaveLength(1);
      expect((await metrics()).requests[0]?.aborted).toBe(true);
      expect((await metrics()).errors).toEqual([]);
      await page.clock.runFor(1000);
      expect((await metrics()).errors).toEqual([]);
    },
  );
});
