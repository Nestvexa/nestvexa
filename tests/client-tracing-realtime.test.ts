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

// DX-035: the Live client sends a validated W3C `traceparent` when tracing is
// enabled and reports the component, sizes and trace id in its diagnostics.
// EXT-004: a burst of realtime invalidations for one component causes one
// read-only refresh. Real Chromium with the built client and a scripted fetch.

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
interface Fixture {
  client: {
    dispose(): void;
    call(element: Element, action: string): Promise<void>;
  };
  sent: Sent[];
  diagnostics: Record<string, unknown>[];
  errors: string[];
  sources: { emit(type: string, data: unknown): void }[];
  failNext: number;
}
declare global {
  interface Window {
    nvClient: typeof import('../packages/client/dist/index.js');
    nvFixture: Fixture;
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
          '<!doctype html><html lang="en"><head><title>Tracing fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end("import * as client from '/index.js'; window.nvClient = client;");
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
    throw new Error('Missing fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvClient'));
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvFixture?.client.dispose());
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

type Tracing = 'true' | 'valid' | 'invalid' | 'throws' | 'none';

/**
 * Mount `names` as Live components (optionally subscribed to the `orders`
 * realtime channel) with a fetch that answers each request with a valid
 * envelope: actions move the revision on, read-only refreshes keep it.
 */
async function mount(
  options: {
    readonly names?: readonly string[];
    readonly tracing?: Tracing;
    readonly invalid?: string;
    readonly realtime?: boolean;
    readonly idempotent?: boolean;
  } = {},
): Promise<void> {
  await page.evaluate(
    ({ names, tracing, invalid, realtime, idempotent }) => {
      const sources: Fixture['sources'] = [];
      class FakeEventSource extends EventTarget {
        static readonly CLOSED = 2;
        readyState = 0;
        constructor(readonly url: string) {
          super();
          sources.push(this);
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('ready', { data: '{"channels":["orders"]}' }),
            ),
          );
        }
        emit(type: string, data: unknown): void {
          this.dispatchEvent(
            new MessageEvent(type, { data: JSON.stringify(data) }),
          );
        }
        close(): void {
          this.readyState = 2;
        }
      }
      Reflect.set(window, 'EventSource', FakeEventSource);
      // A public, server-signed realtime token (body = {"c":["orders"]}).
      const token = `${btoa(JSON.stringify({ c: ['orders'] }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '')}.${'s'.repeat(43)}`;
      names.forEach((name, index) => {
        const element = document.createElement('section');
        element.id = name;
        for (const [key, value] of Object.entries({
          'data-nv-component': `${index + 1}1111111-1111-4111-8111-111111111111`,
          'data-nv-name': name,
          'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          'data-nv-revision': '0',
          'data-nv-endpoint': `/live/${name}`,
          'data-nv-csrf': 'fixture-csrf-012345678901234567890123456789',
          'data-nv-state': JSON.stringify({ count: 0 }),
          ...(realtime ? { 'data-nv-realtime': token } : {}),
          ...(idempotent ? { 'data-nv-idempotent': '["save"]' } : {}),
        }))
          element.setAttribute(key, value);
        element.innerHTML = `<output id="${name}-count" nv:text="count">0</output>`;
        document.querySelector('main')?.append(element);
      });
      const fixture: Fixture = {
        client: undefined as unknown as Fixture['client'],
        sent: [],
        diagnostics: [],
        errors: [],
        sources,
        failNext: 0,
      };
      const tracingOption =
        tracing === 'true'
          ? true
          : tracing === 'valid'
            ? () => '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
            : tracing === 'invalid'
              ? () => invalid
              : tracing === 'throws'
                ? () => {
                    throw new Error('tracing SDK failure');
                  }
                : undefined;
      const revisions = new Map<string, number>();
      fixture.client = window.nvClient.createLiveClient({
        ...(tracingOption === undefined ? {} : { tracing: tracingOption }),
        ...(realtime
          ? { realtime: { endpoint: '/_nestvexa/realtime', transport: 'sse' } }
          : {}),
        onDiagnostic: (event) => fixture.diagnostics.push({ ...event }),
        onError: (error) => fixture.errors.push(error.message),
        fetch: async (url, init) => {
          const headers = Object.fromEntries(new Headers(init?.headers));
          const body = String(init?.body);
          fixture.sent.push({ url: String(url), headers, body });
          if (fixture.failNext > 0) {
            fixture.failNext--;
            return new Response('', { status: 503 });
          }
          const request = JSON.parse(body) as {
            requestId: string;
            revision: number;
            snapshot: string;
          };
          const name = String(url).split('/').at(-2) ?? '';
          const resync = headers['x-nestvexa-resync'] !== undefined;
          const revision = resync ? request.revision : request.revision + 1;
          revisions.set(name, revision);
          const root = document.getElementById(name);
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: request.requestId,
              component: {
                id: root?.getAttribute('data-nv-component'),
                name,
                revision,
              },
              snapshot: request.snapshot,
              state: { count: revision },
              html: `<output id="${name}-count" nv:text="count">${revision}</output>`,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        },
      });
      fixture.client.mount();
      window.nvFixture = fixture;
    },
    {
      names: options.names ?? ['parent'],
      tracing: options.tracing ?? 'none',
      invalid: options.invalid ?? '',
      realtime: options.realtime === true,
      idempotent: options.idempotent === true,
    },
  );
}
const call = (name = 'parent', action = 'save') =>
  page.evaluate(
    async ({ name, action }) => {
      const root = document.getElementById(name);
      if (!root) throw new Error('Missing component');
      await window.nvFixture.client.call(root, action);
    },
    { name, action },
  );
const fixture = () =>
  page.evaluate(() => ({
    sent: window.nvFixture.sent,
    diagnostics: window.nvFixture.diagnostics,
    errors: window.nvFixture.errors,
  }));
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

describe('Live client trace context', () => {
  it('sends a fresh sampled traceparent per request and reports it with sizes', async () => {
    await mount({ tracing: 'true' });
    await call();
    await call();
    const { sent, diagnostics, errors } = await fixture();
    expect(errors).toEqual([]);
    const headers = sent.map((request) => request.headers['traceparent'] ?? '');
    for (const header of headers) expect(header).toMatch(traceparentPattern);
    const [first, second] = headers.map(
      (header) => traceparentPattern.exec(header)?.[1],
    );
    expect(first).not.toBe(second);
    const request = diagnostics.find((sample) => sample['phase'] === 'request');
    expect(request).toMatchObject({
      outcome: 'succeeded',
      component: 'parent',
      traceId: first,
      requestBytes: new TextEncoder().encode(sent[0]?.body ?? '').byteLength,
    });
    expect(request?.['responseBytes']).toBeGreaterThan(100);
    for (const sample of diagnostics) {
      expect(sample['component']).toBe('parent');
      expect(Object.keys(sample).sort()).toEqual(
        expect.arrayContaining(['milliseconds', 'outcome', 'phase']),
      );
      // Still no state, tokens, URLs or action names.
      const serialized = JSON.stringify(sample);
      for (const leaked of ['fixture-csrf', '/live/', 'save', 'AAAAAAAA'])
        expect(serialized).not.toContain(leaked);
    }
  });

  it('sends a valid host-supplied traceparent unchanged and retries with the same one', async () => {
    await mount({ tracing: 'valid', idempotent: true });
    await page.evaluate(() => {
      window.nvFixture.failNext = 1;
    });
    await call();
    const { sent, diagnostics } = await fixture();
    expect(sent).toHaveLength(2);
    for (const request of sent)
      expect(request.headers['traceparent']).toBe(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      );
    expect(sent[0]?.body).toBe(sent[1]?.body);
    expect(
      diagnostics.every(
        (sample) => sample['traceId'] === '4bf92f3577b34da6a3ce929d0e0e4736',
      ),
    ).toBe(true);
  });

  it.each([
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01',
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`,
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nx-evil: 1',
    '',
  ])('never sends a malformed traceparent (%j)', async (invalid) => {
    await mount({ tracing: 'invalid', invalid });
    await call();
    const { sent, diagnostics, errors } = await fixture();
    expect(errors).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['traceparent']).toBeUndefined();
    expect(diagnostics.some((sample) => 'traceId' in sample)).toBe(false);
  });

  it('keeps requests flowing when the tracing SDK throws, and sends nothing by default', async () => {
    await mount({ tracing: 'throws' });
    await call();
    let state = await fixture();
    expect(state.errors).toEqual([]);
    expect(state.sent[0]?.headers['traceparent']).toBeUndefined();
    await page.evaluate(() => window.nvFixture.client.dispose());
    await page.evaluate(() =>
      document.querySelector('main')?.replaceChildren(),
    );
    await mount({ names: ['plain'] });
    await call('plain');
    state = await fixture();
    expect(state.sent[0]?.headers['traceparent']).toBeUndefined();
    const code = await page.evaluate(() => {
      try {
        window.nvClient.createLiveClient({ tracing: 'yes' as never });
        return null;
      } catch (error) {
        return String(Reflect.get(Object(error), 'code'));
      }
    });
    expect(code).toBe('DIRECTIVE');
  });
});

describe('realtime refresh coalescing', () => {
  async function burst(ids: readonly string[]): Promise<void> {
    await page.evaluate((ids) => {
      const source = window.nvFixture.sources.at(-1);
      if (!source) throw new Error('No realtime connection');
      for (const id of ids)
        source.emit('invalidate', { channel: 'orders', id, data: null });
    }, ids);
  }
  const refreshes = async () =>
    (await fixture()).sent.filter(
      (request) => request.headers['x-nestvexa-resync'] === '1',
    );

  it('turns a burst of invalidations for one component into one read-only refresh', async () => {
    await mount({ realtime: true });
    await expect
      .poll(() => page.evaluate(() => window.nvFixture.sources.length))
      .toBe(1);
    await burst(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
    await expect.poll(async () => (await refreshes()).length).toBe(1);
    // Nothing else is scheduled once the 50 ms window has passed.
    await page.waitForTimeout(300);
    const [refresh] = await refreshes();
    expect(await refreshes()).toHaveLength(1);
    expect(new URL(refresh?.url ?? '').pathname).toBe('/live/parent/_sync');
    // Read-only: the refresh sends no drafts and keeps the revision.
    expect(JSON.parse(refresh?.body ?? '{}')).toMatchObject({
      revision: 0,
      updates: {},
    });
    // A later burst is a new window: exactly one more refresh.
    await burst(['e9', 'e10', 'e11']);
    await expect.poll(async () => (await refreshes()).length).toBe(2);
    await page.waitForTimeout(300);
    expect(await refreshes()).toHaveLength(2);
    // Replayed event ids are dropped before they can schedule anything.
    await burst(['e9', 'e10']);
    await page.waitForTimeout(300);
    expect(await refreshes()).toHaveLength(2);
    expect((await fixture()).errors).toEqual([]);
  });

  it('coalesces per component: one refresh each for two subscribed components', async () => {
    await mount({ names: ['alpha', 'beta'], realtime: true });
    await expect
      .poll(() => page.evaluate(() => window.nvFixture.sources.length))
      .toBe(1);
    await burst(['a1', 'a2', 'a3', 'a4']);
    await expect.poll(async () => (await refreshes()).length).toBe(2);
    await page.waitForTimeout(300);
    const urls = (await refreshes())
      .map((request) => new URL(request.url).pathname)
      .sort();
    expect(urls).toEqual(['/live/alpha/_sync', '/live/beta/_sync']);
  });
});
