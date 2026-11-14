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
  input: unknown;
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
  headers: Headers;
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
  renderless?: unknown;
  snapshot?: string;
  /** Response revision (defaults to the request revision + 1). */
  revision?: number;
  headers?: Record<string, string>;
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
      diagnostics: import('../packages/client/dist/index.js').LiveDiagnostic[];
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
  diagnostics?: 'collect' | 'throw';
  offline?: boolean;
  extraHtml?: string;
  state?: Record<string, unknown>;
}
/** Actual Chromium with deliberately controlled fetch/streams; not Nest protocol conformance. */
async function mount(options: MountOptions = { timeout: 100 }): Promise<void> {
  await page.evaluate(
    ({
      timeout,
      second,
      nested,
      live,
      diagnostics,
      offline,
      extraHtml,
      state,
    }) => {
      const html = (name: string) =>
        `<form id="${name}-form" nv:submit="save"><label for="${name}-edit">Query</label><input id="${name}-edit" nv:model${live ? '.live.debounce.25ms' : ''}="query" value="initial"><button type="submit">Save</button></form><button id="${name}-slow" type="button" nv:click="slow" nv:loading.attr="disabled" nv:target="slow">Slow</button><span id="${name}-loading" nv:loading="" nv:target="slow" hidden>Pending</span><output id="${name}-count" nv:text="count">0</output><output id="${name}-query" nv:text="query">initial</output>${offline ? `<p id="${name}-offline" nv:offline="" hidden role="status">Connection may be unavailable</p>` : ''}`;
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
          'data-nv-state': JSON.stringify({
            query: 'initial',
            count: 0,
            ...state,
          }),
        }))
          element.setAttribute(key, value);
        element.innerHTML = html(name);
        if (name === 'parent' && extraHtml)
          element.insertAdjacentHTML('beforeend', extraHtml);
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
      const samples: import('../packages/client/dist/index.js').LiveDiagnostic[] =
        [];
      const client = window.nvTransportFixture.createLiveClient({
        ...(timeout === undefined ? {} : { requestTimeoutMs: timeout }),
        ...(diagnostics
          ? {
              onDiagnostic(
                event: import('../packages/client/dist/index.js').LiveDiagnostic,
              ) {
                if (!Object.isFrozen(event))
                  throw new Error('Mutable diagnostic');
                samples.push(event);
                if (diagnostics === 'throw')
                  throw new Error('Private sink failure');
              },
            }
          : {}),
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
              headers: new Headers(init?.headers),
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
        diagnostics: samples,
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
              revision: spec.revision ?? request.body.revision + 1,
            },
            snapshot: spec.snapshot ?? request.body.snapshot,
            state: spec.state ?? {
              query: 'server',
              count: request.body.revision + 1,
            },
            html: spec.html ?? (spec.renderless === true ? '' : html(name)),
            ...(spec.renderless === undefined
              ? {}
              : { renderless: spec.renderless }),
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
          for (const [key, value] of Object.entries(spec.headers ?? {}))
            headers.set(key, value);
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
              if (spec.mode === 'hang-cancel')
                return new Promise<void>(() => {});
            },
          });
          request.resolve(
            new Response(stream, { status: spec.status ?? 200, headers }),
          );
        },
      };
      client.mount();
    },
    options,
  );
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

describe('renderless acknowledgements in actual Chromium with controlled fetch', () => {
  const nextSnapshot = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it.each(['input', 'editor'] as const)(
    'retains native controls, local widgets and the focused %s without parsing or morphing',
    async (focused) => {
      await mount({
        timeout: 1000,
        nested: true,
        diagnostics: 'collect',
        state: { visible: true, title: 'initial title' },
        extraHtml:
          '<p id="unbound">Initial Handlebars count: 0</p><p id="visibility" nv:show="visible">Visible</p><p id="title" nv:bind="title:title">Title</p><p id="dirty" nv:dirty="query">Unsaved</p><div id="editor" contenteditable="true">Local editor text</div><input id="file" type="file"><nv-renderless-widget id="widget"></nv-renderless-widget><div style="height:1000px;width:1000px"></div>',
      });
      const inspect = await page.evaluate((focused) => {
        const session = window.nvTransportSession;
        const root = document.getElementById('parent');
        const input = document.getElementById('parent-edit');
        const editor = document.getElementById('editor');
        const file = document.getElementById('file');
        const widget = document.getElementById('widget');
        const child = document.getElementById('other');
        if (
          !root ||
          !(input instanceof HTMLInputElement) ||
          !editor ||
          !(file instanceof HTMLInputElement) ||
          !widget ||
          !child
        )
          throw new Error('Missing renderless fixture');
        const calls = {
          templates: 0,
          clones: 0,
          inserted: 0,
          removed: 0,
          connected: 0,
          disconnected: 0,
          updated: 0,
        };
        customElements.define(
          'nv-renderless-widget',
          class extends HTMLElement {
            connectedCallback() {
              calls.connected++;
            }
            disconnectedCallback() {
              calls.disconnected++;
            }
          },
        );
        const localWidgetState = { history: ['local-only'] };
        Reflect.set(widget, 'localState', localWidgetState);
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(['local bytes'], 'retained.txt', { type: 'text/plain' }),
        );
        file.files = transfer.files;
        const files = file.files;
        const selectedFile = files?.[0];
        root.style.cssText = 'height:180px;width:300px;overflow:auto';
        root.scrollTop = 63;
        root.scrollLeft = 17;
        session.client.set(root, 'query', 'sent draft');
        if (focused === 'input') {
          input.focus({ preventScroll: true });
          input.setSelectionRange(2, 6, 'backward');
        } else {
          editor.focus({ preventScroll: true });
          const range = document.createRange();
          const text = editor.firstChild;
          if (!text) throw new Error('Missing editor text');
          range.setStart(text, 2);
          range.setEnd(text, 7);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        const editorText = editor.firstChild;
        const scroll = { top: root.scrollTop, left: root.scrollLeft };
        root.addEventListener('nestvexa:before-remove', () => calls.removed++);
        root.addEventListener('nestvexa:after-insert', () => calls.inserted++);
        root.addEventListener('nestvexa:updated', () => calls.updated++);
        const createElement = document.createElement.bind(document);
        Object.defineProperty(document, 'createElement', {
          value(tag: string, options?: ElementCreationOptions) {
            if (tag.toLowerCase() === 'template') calls.templates++;
            return createElement(tag, options);
          },
        });
        const cloneNode = Node.prototype.cloneNode;
        Node.prototype.cloneNode = function (this: Node, deep = false) {
          calls.clones++;
          return cloneNode.call(this, deep);
        };
        Reflect.set(window, 'nvRenderlessInspect', () => {
          const selection = document.getSelection();
          return {
            identities: [
              input === document.getElementById('parent-edit'),
              editor === document.getElementById('editor'),
              editorText === editor.firstChild,
              file === document.getElementById('file'),
              files === file.files,
              selectedFile === file.files?.[0],
              widget === document.getElementById('widget'),
              Reflect.get(widget, 'localState') === localWidgetState,
              child === document.getElementById('other'),
            ],
            active: document.activeElement?.id,
            inputSelection: [
              input.selectionStart,
              input.selectionEnd,
              input.selectionDirection,
            ],
            editorSelection: [
              selection?.anchorNode === editorText,
              selection?.anchorOffset,
              selection?.focusNode === editorText,
              selection?.focusOffset,
            ],
            scroll: { top: root.scrollTop, left: root.scrollLeft },
            calls,
          };
        });
        return { scroll };
      }, focused);
      const task = await start('save');
      await reply(0, {
        renderless: true,
        snapshot: nextSnapshot,
        state: {
          query: 'sent draft',
          count: 9,
          visible: false,
          title: 'acknowledged title',
        },
      });
      expect(await result(task)).toEqual({ ok: true, code: null });
      const retained = await page.evaluate(() => {
        const inspect = Reflect.get(window, 'nvRenderlessInspect') as () => {
          identities: boolean[];
          active: string;
          inputSelection: unknown[];
          editorSelection: unknown[];
          scroll: { top: number; left: number };
          calls: Record<string, number>;
        };
        return inspect();
      });
      expect(retained.identities).toEqual(Array<boolean>(9).fill(true));
      expect(retained.active).toBe(
        focused === 'input' ? 'parent-edit' : 'editor',
      );
      if (focused === 'input')
        expect(retained.inputSelection).toEqual([2, 6, 'backward']);
      else expect(retained.editorSelection).toEqual([true, 2, true, 7]);
      expect(retained.scroll).toEqual(inspect.scroll);
      expect(retained.calls).toEqual({
        templates: 0,
        clones: 0,
        inserted: 0,
        removed: 0,
        connected: 1,
        disconnected: 0,
        updated: 1,
      });
      expect(await page.locator('#parent-count').textContent()).toBe('9');
      expect(await page.locator('#parent-query').textContent()).toBe(
        'sent draft',
      );
      expect(await page.locator('#unbound').textContent()).toBe(
        'Initial Handlebars count: 0',
      );
      expect(
        await page.locator('#visibility').getAttribute('hidden'),
      ).not.toBeNull();
      expect(
        await page.locator('#dirty').getAttribute('hidden'),
      ).not.toBeNull();
      expect(await page.locator('#title').getAttribute('title')).toBe(
        'acknowledged title',
      );
      expect(await page.locator('#other-count').textContent()).toBe('0');
      expect(
        await page.locator('#other').getAttribute('data-nv-revision'),
      ).toBe('0');
      expect(
        await page.locator('#parent').getAttribute('data-nv-snapshot'),
      ).toBe(nextSnapshot);
      expect(
        await page.locator('#parent').getAttribute('data-nv-revision'),
      ).toBe('1');
      expect(
        await page.evaluate(() =>
          window.nvTransportSession.diagnostics.map(({ phase }) => phase),
        ),
      ).toEqual(['queue', 'request']);
      const next = await start('save');
      expect(
        await page.evaluate(() => window.nvTransportSession.requests[1]?.body),
      ).toMatchObject({ revision: 1, snapshot: nextSnapshot, updates: {} });
      // Every bound field must remain present in an acknowledgement.
      await reply(1, {
        renderless: true,
        state: {
          query: 'sent draft',
          count: 10,
          visible: false,
          title: 'acknowledged title',
        },
      });
      expect(await result(next)).toEqual({ ok: true, code: null });
      expect(await page.locator('#parent-count').textContent()).toBe('10');
    },
  );

  it('queues with the acknowledged snapshot and retains an edit made after dispatch', async () => {
    await mount({
      timeout: 1000,
      extraHtml: '<p id="dirty" nv:dirty="query">Unsaved</p>',
    });
    await page.locator('#parent-edit').fill('sent draft');
    const first = await start('save');
    expect(
      await page.evaluate(() =>
        window.nvTransportSession.requests[0]?.headers.get(
          'x-nestvexa-capabilities',
        ),
      ),
    ).toBe('renderless-v1');
    await page.locator('#parent-edit').fill('newer local edit');
    const queued = await start('save');
    expect((await metrics()).requests).toHaveLength(1);
    await reply(0, {
      renderless: true,
      snapshot: nextSnapshot,
      state: { query: 'server accepted sent draft', count: 1 },
    });
    expect(await result(first)).toEqual({ ok: true, code: null });
    expect(await page.locator('#parent-edit').inputValue()).toBe(
      'newer local edit',
    );
    expect(await page.locator('#parent-query').textContent()).toBe(
      'newer local edit',
    );
    expect(await page.locator('#dirty').getAttribute('hidden')).toBeNull();
    expect(
      await page.evaluate(() => window.nvTransportSession.requests[1]?.body),
    ).toMatchObject({
      revision: 1,
      snapshot: nextSnapshot,
      updates: { query: 'newer local edit' },
    });
    expect(
      await page.evaluate(() =>
        JSON.parse(
          document.getElementById('parent')?.getAttribute('data-nv-state') ??
            '{}',
        ),
      ),
    ).toEqual({ query: 'server accepted sent draft', count: 1 });
    await reply(1, {
      renderless: true,
      state: { query: 'newer local edit', count: 2 },
    });
    expect(await result(queued)).toEqual({ ok: true, code: null });
    expect(await page.locator('#dirty').getAttribute('hidden')).not.toBeNull();
    await page.clock.runFor(500);
    expect((await metrics()).requests).toHaveLength(2);
  });

  it.each([
    {
      label: 'mixed HTML',
      spec: { renderless: true, html: '<p id="attacker">Injected</p>' },
      code: 'RESPONSE',
    },
    {
      label: 'invalid renderless flag',
      spec: { renderless: 'true', html: '' },
      code: 'RESPONSE',
    },
    {
      label: 'invalid bound state',
      spec: {
        renderless: true,
        state: { query: 'partial', count: { invalid: true } },
      },
      code: 'DIRECTIVE',
    },
  ])(
    'rejects $label before committing state or metadata and never retries',
    async ({ spec, code }) => {
      await mount({ timeout: 1000 });
      const task = await start('save');
      const queued = await start('save');
      await reply(0, { ...spec, snapshot: nextSnapshot });
      expect(await result(task)).toEqual({ ok: false, code });
      expect(await result(queued)).toEqual({ ok: false, code });
      expect(await page.locator('#parent-count').textContent()).toBe('0');
      expect(await page.locator('#parent-query').textContent()).toBe('initial');
      expect(await page.locator('#parent-edit').inputValue()).toBe('initial');
      expect(
        await page.locator('#parent').getAttribute('data-nv-revision'),
      ).toBe('0');
      expect(
        await page.locator('#parent').getAttribute('data-nv-snapshot'),
      ).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(
        await page.evaluate(() =>
          JSON.parse(
            document.getElementById('parent')?.getAttribute('data-nv-state') ??
              '{}',
          ),
        ),
      ).toEqual({ query: 'initial', count: 0 });
      expect(await page.locator('#attacker').count()).toBe(0);
      expect(await result(await start('save'))).toEqual({ ok: false, code });
      await page.clock.runFor(2000);
      expect((await metrics()).requests).toHaveLength(1);
      expect((await metrics()).errors.map(({ code }) => code)).toEqual([code]);
    },
  );

  it('advertises renderless support while accepting ordinary server HTML', async () => {
    await mount({ timeout: 1000 });
    const task = await start('save');
    expect(
      await page.evaluate(() =>
        window.nvTransportSession.requests[0]?.headers.get(
          'x-nestvexa-capabilities',
        ),
      ),
    ).toBe('renderless-v1');
    await reply(0, {
      html: '<p id="server-html">Ordinary render</p><output nv:text="count">0</output>',
    });
    expect(await result(task)).toEqual({ ok: true, code: null });
    expect(await page.locator('#server-html').textContent()).toBe(
      'Ordinary render',
    );
  });

  it('omits the capability for sort-origin requests and applies authoritative server HTML', async () => {
    const list =
      '<ol nv:sort="reorder" aria-label="Tasks"><li nv:sort.item="a"><button id="sort-a" type="button" nv:sort.handle aria-label="Move A">A</button></li><li nv:sort.item="b"><button id="sort-b" type="button" nv:sort.handle aria-label="Move B">B</button></li></ol>';
    await mount({ timeout: 1000, extraHtml: list });
    await page.locator('#sort-a').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.clock.runFor(0);
    expect(
      await page.evaluate(() =>
        window.nvTransportSession.requests.map(({ headers, body }) => ({
          capability: headers.get('x-nestvexa-capabilities'),
          input: body.input,
        })),
      ),
    ).toEqual([{ capability: null, input: { ids: ['b', 'a'] } }]);
    await reply(0, {
      html: list.replace(
        /(<li nv:sort.item="a">.*?<\/li>)(<li nv:sort.item="b">.*?<\/li>)/,
        '$2$1',
      ),
    });
    expect(
      await page
        .locator('[nv\\:sort] > li')
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute('nv:sort.item')),
        ),
    ).toEqual(['b', 'a']);
    expect((await metrics()).errors).toEqual([]);
  });
});

describe('bounded browser request lifecycle', () => {
  it('rejects a combined oversized request before dispatch and allows correction without suspension', async () => {
    await mount({ timeout: 1000 });
    const rejected = await page.evaluate(async () => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing component');
      const { client } = window.nvTransportSession;
      client.set(root, 'query', 'x'.repeat(50_000));
      try {
        await client.call(root, 'save', { text: 'y'.repeat(16_000) });
        return false;
      } catch (error) {
        return (
          error instanceof Error && Reflect.get(error, 'code') === 'DIRECTIVE'
        );
      }
    });
    expect(rejected).toBe(true);
    expect((await metrics()).requests).toHaveLength(0);
    await page.evaluate(() => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing component');
      window.nvTransportSession.client.set(root, 'query', 'corrected');
    });
    const retry = await start();
    await reply(0);
    expect(await result(retry)).toEqual({ ok: true, code: null });
  });
  it('captures detached input at enqueue and preserves it across earlier renders', async () => {
    await mount({ timeout: 1000 });
    await start();
    await page.evaluate(() => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing component');
      const input = { ids: ['first', 'second'] };
      const session = window.nvTransportSession;
      void session.client.call(root, 'save', input).catch(() => undefined);
      input.ids.reverse();
      input.ids.push('late');
      if (Object.isFrozen(input) || Object.isFrozen(input.ids))
        throw new Error('Caller input must remain mutable');
    });
    expect((await metrics()).requests).toHaveLength(1);
    await reply(0);
    expect(
      await page.evaluate(
        () => window.nvTransportSession.requests[1]?.body.input,
      ),
    ).toEqual({ ids: ['first', 'second'] });
    await reply(1);
  });
  it('rejects unsafe input locally without sending or poisoning a valid component', async () => {
    await mount({ timeout: 1000 });
    const outcome = await page.evaluate(async () => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing component');
      let reads = 0;
      const input = Object.defineProperty({}, 'secret', {
        enumerable: true,
        get() {
          reads++;
          return 'secret';
        },
      });
      try {
        await window.nvTransportSession.client.call(root, 'save', input);
        return { rejected: false, reads };
      } catch {
        return { rejected: true, reads };
      }
    });
    expect(outcome).toEqual({ rejected: true, reads: 0 });
    expect((await metrics()).requests).toHaveLength(0);
    const retry = await start();
    await reply(0);
    expect(await result(retry)).toEqual({ ok: true, code: null });
  });
  it.each([
    { code: 'HTTP', spec: { status: 422 } },
    { code: 'RESPONSE', spec: { raw: '{' } },
    { code: 'HTML', spec: { html: '<script>invalid</script>' } },
    {
      code: 'DIRECTIVE',
      spec: {
        html: '<a href="/safe" nv:current.unsupported="active">Invalid</a>',
      },
    },
  ])(
    'does not report $code errors as lost connectivity',
    async ({ code, spec }) => {
      await mount({ timeout: 1000, offline: true });
      expect(await page.locator('#parent-offline').isVisible()).toBe(false);
      const task = await start();
      await reply(0, spec);
      expect(await result(task)).toEqual({ ok: false, code });
      expect(await page.locator('#parent-offline').isVisible()).toBe(false);
      if (code === 'HTTP') {
        const retry = await start();
        await reply(1);
        expect(await result(retry)).toEqual({ ok: true, code: null });
        expect(await page.locator('#parent-offline').isVisible()).toBe(false);
      } else {
        const suspended = await start();
        await page.clock.runFor(0);
        expect(await result(suspended)).toEqual({ ok: false, code });
        expect((await metrics()).requests).toHaveLength(1);
      }
    },
  );

  it.each(['NETWORK', 'TIMEOUT'] as const)(
    'shows $0 connectivity failure while preserving uncertain-state suspension',
    async (code) => {
      await mount({ timeout: 100, offline: true, second: true });
      const failed = await start();
      if (code === 'NETWORK') {
        await page.evaluate(() =>
          window.nvTransportSession.requests[0]?.reject(
            new Error('Private transport failure'),
          ),
        );
        await page.clock.runFor(0);
      } else await page.clock.runFor(101);
      expect(await result(failed)).toEqual({ ok: false, code });
      expect(await page.locator('#parent-offline').isVisible()).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      expect(await page.locator('#parent-offline').isVisible()).toBe(true);
      const sibling = await start('slow', '#other');
      await reply(1);
      expect(await result(sibling)).toEqual({ ok: true, code: null });
      expect(await page.locator('#other-offline').isVisible()).toBe(false);
      expect(await page.locator('#parent-offline').isVisible()).toBe(true);
      const suspended = await start();
      await page.clock.runFor(0);
      expect(await result(suspended)).toEqual({ ok: false, code });
      expect((await metrics()).requests).toHaveLength(2);
      // Simulate a host replacing uncertain state with an authoritative fresh
      // server render. There is no automatic retry of the uncertain mutation.
      await page.evaluate(() => {
        const old = document.querySelector('#parent');
        if (!old) throw new Error('Missing parent');
        const fresh = old.cloneNode(true);
        if (!(fresh instanceof Element)) throw new Error('Missing fresh root');
        fresh.setAttribute(
          'data-nv-snapshot',
          'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        );
        fresh.setAttribute('data-nv-revision', '1');
        fresh.setAttribute(
          'data-nv-state',
          JSON.stringify({ query: 'reconciled', count: 1 }),
        );
        old.replaceWith(fresh);
      });
      await page.clock.runFor(0);
      const reconciled = await start();
      await reply(2);
      expect(await result(reconciled)).toEqual({ ok: true, code: null });
      expect(await page.locator('#parent-offline').isVisible()).toBe(false);
    },
  );

  it('keeps diagnostics disabled by default', async () => {
    await mount();
    const task = await start();
    await reply(0);
    expect(await result(task)).toEqual({ ok: true, code: null });
    expect(
      await page.evaluate(() => window.nvTransportSession.diagnostics),
    ).toEqual([]);
  });

  it('measures separate queued, request and morph phases without private data or sink coupling', async () => {
    await mount({ timeout: 1000, diagnostics: 'throw' });
    const first = await start();
    const second = await start('save');
    await page.clock.runFor(40);
    await reply(0);
    await page.clock.runFor(20);
    await reply(1);
    for (const task of [first, second])
      expect(await result(task)).toEqual({ ok: true, code: null });
    const samples = await page.evaluate(
      () => window.nvTransportSession.diagnostics,
    );
    expect(samples.map(({ phase, outcome }) => ({ phase, outcome }))).toEqual(
      [0, 1].flatMap(() =>
        ['queue', 'request', 'morph'].map((phase) => ({
          phase,
          outcome: 'succeeded',
        })),
      ),
    );
    expect(samples[1]?.milliseconds).toBe(40);
    expect(samples[3]?.milliseconds).toBe(40);
    expect(samples[4]?.milliseconds).toBe(20);
    for (const sample of samples) {
      expect(Object.keys(sample).sort()).toEqual([
        'milliseconds',
        'outcome',
        'phase',
      ]);
      expect(
        Number.isFinite(sample.milliseconds) && sample.milliseconds >= 0,
      ).toBe(true);
    }
    expect((await metrics()).errors).toEqual([]);
    expect(await page.locator('#parent').getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it.each(['rejection', 'invalid-fragment', 'dispose'] as const)(
    'reports %s with bounded phase outcomes',
    async (mode) => {
      await mount({ timeout: 1000, diagnostics: 'collect' });
      const task = await start();
      if (mode === 'dispose') {
        await page.evaluate(() => window.nvTransportSession.client.dispose());
        await page.clock.runFor(0);
      } else
        await reply(
          0,
          mode === 'rejection'
            ? { status: 422 }
            : { html: '<script>private payload</script>' },
        );
      const samples = await page.evaluate(
        () => window.nvTransportSession.diagnostics,
      );
      expect(samples.map(({ phase }) => phase)).toEqual(
        mode === 'invalid-fragment'
          ? ['queue', 'request', 'morph']
          : ['queue', 'request'],
      );
      expect(samples.at(-1)?.outcome).toBe(
        mode === 'dispose' ? 'cancelled' : 'failed',
      );
      expect(await result(task)).toEqual(
        mode === 'dispose'
          ? { ok: true, code: null }
          : { ok: false, code: mode === 'rejection' ? 'HTTP' : 'HTML' },
      );
    },
  );

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

  const staleHint = {
    status: 409,
    mode: 'empty',
    headers: { 'x-nestvexa-recovery': 'resync' },
  } as const;

  it('answers STALE_REVISION with one fresh resync and no replay of the failed call', async () => {
    await mount();
    await page.locator('#parent-edit').fill('kept draft');
    const task = await start();
    const queued = await start('save');
    await reply(0, staleHint);
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    // The queued request still carries the stale revision: it fails the same
    // way and shares the single resync instead of scheduling another.
    await expect.poll(async () => (await metrics()).requests.length).toBe(2);
    await reply(1, staleHint);
    expect(await result(queued)).toEqual({ ok: false, code: 'HTTP' });
    await expect.poll(async () => (await metrics()).requests.length).toBe(3);
    const resync = await page.evaluate(() => {
      const request = window.nvTransportSession.requests[2];
      return {
        url: new URL(request?.url ?? '', location.href).pathname,
        header: request?.headers.get('x-nestvexa-resync') ?? null,
        updates: request?.body.updates,
        revision: request?.body.revision,
      };
    });
    // No drafts are written by the resync; the failed action is not resent.
    expect(resync).toEqual({
      url: '/live/parent/_sync',
      header: '1',
      updates: {},
      revision: 0,
    });
    // The server answers with its current revision, which may be any newer one.
    await reply(2, { revision: 5, state: { query: 'server', count: 5 } });
    expect(await page.locator('#parent-count').textContent()).toBe('5');
    // The local draft survives and goes with the next request, at the new revision.
    expect(await page.locator('#parent-edit').inputValue()).toBe('kept draft');
    const next = await start();
    const sent = await page.evaluate(
      () => window.nvTransportSession.requests[3]?.body,
    );
    expect(sent).toMatchObject({
      revision: 5,
      updates: { query: 'kept draft' },
    });
    expect(
      await page.evaluate(
        () =>
          window.nvTransportSession.requests[3]?.headers.get(
            'x-nestvexa-resync',
          ) ?? null,
      ),
    ).toBeNull();
    await reply(3, { state: { query: 'kept draft', count: 6 } });
    expect(await result(next)).toEqual({ ok: true, code: null });
    expect((await metrics()).errors.map((error) => error.code)).toEqual([
      'HTTP',
      'HTTP',
    ]);
  });

  it('suspends when the resync itself is stale instead of looping', async () => {
    await mount();
    const task = await start();
    await reply(0, staleHint);
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await expect.poll(async () => (await metrics()).requests.length).toBe(2);
    await reply(1, staleHint);
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(2);
    // Suspended: a later call is rejected without another request.
    const later = await start();
    await page.clock.runFor(0);
    expect(await result(later)).toEqual({ ok: false, code: 'HTTP' });
    expect((await metrics()).requests).toHaveLength(2);
    expect(
      await page.locator('#parent').getAttribute('data-nv-suspended'),
    ).toBe('');
  });

  it('applies a read-only refresh that keeps the current revision', async () => {
    await mount();
    const task = await start();
    await reply(0, staleHint);
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await expect.poll(async () => (await metrics()).requests.length).toBe(2);
    // A refresh answers with the stored revision, which may equal the
    // client's (nothing committed since); it is applied, not rejected.
    await reply(1, { revision: 0, state: { query: 'server', count: 3 } });
    expect(await page.locator('#parent-count').textContent()).toBe('3');
    const next = await start();
    expect(
      await page.evaluate(() => window.nvTransportSession.requests[2]?.body),
    ).toMatchObject({ revision: 0 });
    await reply(2, { revision: 1, state: { query: 'server', count: 4 } });
    expect(await result(next)).toEqual({ ok: true, code: null });
  });

  const conflictHint = {
    status: 409,
    mode: 'empty',
    headers: { 'x-nestvexa-recovery': 'commit' },
  } as const;

  it('commits once when a read-only refresh would change the child tree', async () => {
    await mount();
    const task = await start();
    await reply(0, staleHint);
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await expect.poll(async () => (await metrics()).requests.length).toBe(2);
    await reply(1, conflictHint);
    await expect.poll(async () => (await metrics()).requests.length).toBe(3);
    const commit = await page.evaluate(() => {
      const request = window.nvTransportSession.requests[2];
      return {
        url: new URL(request?.url ?? '', location.href).pathname,
        header: request?.headers.get('x-nestvexa-resync') ?? null,
        updates: request?.body.updates,
      };
    });
    expect(commit).toEqual({
      url: '/live/parent/_sync',
      header: 'commit',
      updates: {},
    });
    await reply(2, { revision: 6, state: { query: 'server', count: 6 } });
    expect(await page.locator('#parent-count').textContent()).toBe('6');
    expect(
      await page.locator('#parent').getAttribute('data-nv-suspended'),
    ).toBeNull();
  });

  it('suspends instead of looping when the commit is refused the same way', async () => {
    await mount();
    const task = await start();
    await reply(0, staleHint);
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await expect.poll(async () => (await metrics()).requests.length).toBe(2);
    await reply(1, conflictHint);
    await expect.poll(async () => (await metrics()).requests.length).toBe(3);
    await reply(2, conflictHint);
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(3);
    expect(
      await page.locator('#parent').getAttribute('data-nv-suspended'),
    ).toBe('');
  });

  it('ignores the commit hint outside a read-only refresh', async () => {
    await mount();
    const task = await start();
    await reply(0, conflictHint);
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(1);
  });

  it('ignores the resync hint on statuses other than 409', async () => {
    await mount();
    const task = await start();
    await reply(0, { ...staleHint, status: 500 });
    expect(await result(task)).toEqual({ ok: false, code: 'HTTP' });
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(1);
    expect(
      await page.locator('#parent').getAttribute('data-nv-suspended'),
    ).toBe('');
  });

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
