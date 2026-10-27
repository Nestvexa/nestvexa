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
interface RenderRequest {
  url: string;
  body: RequestBody;
  signal: AbortSignal | null;
}
interface TaskResult {
  ok: boolean;
  code?: string;
}
declare global {
  interface Window {
    nvRenderingFixture: typeof import('../packages/client/dist/index.js');
    nvRenderingSession: {
      client: ReturnType<
        typeof import('../packages/client/dist/index.js').createLiveClient
      >;
      requests: RenderRequest[];
      errors: { code: string | null; message: string }[];
      tasks: Promise<TaskResult>[];
      respond(
        index: number,
        html: string,
        state?: Record<string, unknown>,
      ): void;
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
          '<!doctype html><html lang="en"><head><title>Client rendering lifecycle fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; window.nvRenderingFixture = client;",
        );
      return;
    }
    if (!/^\/[a-z-]+\.js$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    const source = new URL(
      `../packages/client/dist/${pathname.slice(1)}`,
      import.meta.url,
    );
    void readFile(source, 'utf8').then(
      (text) =>
        response
          .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          .end(text),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing rendering fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvRenderingFixture'));
  await page.clock.install();
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvRenderingSession?.client.dispose());
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

/** Actual browser lifecycle tests with controlled transport; these do not claim Nest/server conformance. */
async function mount(html: string, rootAttribute?: string): Promise<void> {
  await page.evaluate(
    ({ html, rootAttribute }) => {
      const root = document.createElement('section');
      root.id = 'parent';
      for (const [name, value] of Object.entries({
        'data-nv-component': '11111111-1111-4111-8111-111111111111',
        'data-nv-name': 'parent',
        'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'data-nv-revision': '0',
        'data-nv-endpoint': '/live/parent',
        'data-nv-csrf': 'host-csrf-012345678901234567890123456789',
        'data-nv-state': JSON.stringify({ query: 'initial', count: 0 }),
      }))
        root.setAttribute(name, value);
      root.innerHTML = html;
      if (rootAttribute) root.setAttribute(rootAttribute, '');
      document.querySelector('main')?.append(root);
      const requests: RenderRequest[] = [];
      const errors: { code: string | null; message: string }[] = [];
      const tasks: Promise<TaskResult>[] = [];
      const replies: ((
        html: string,
        state: Record<string, unknown>,
      ) => void)[] = [];
      const client = window.nvRenderingFixture.createLiveClient({
        onError: (error) =>
          errors.push({
            code:
              typeof Reflect.get(error, 'code') === 'string'
                ? String(Reflect.get(error, 'code'))
                : null,
            message: error.message,
          }),
        fetch: (url, options) => {
          const body = JSON.parse(String(options?.body)) as RequestBody;
          const name = new URL(String(url), location.href).pathname
            .split('/')
            .at(-2);
          const marker = document.querySelector(`[data-nv-name="${name}"]`);
          if (!(marker instanceof HTMLElement) || !name)
            throw new Error('Missing requested component marker');
          const id = marker.dataset['nvComponent'];
          requests.push({
            url: String(url),
            body,
            signal: options?.signal ?? null,
          });
          return new Promise<Response>((resolve) => {
            // Deliberately let a canceled transport complete late to test stale response exclusion.
            replies.push((html, state) =>
              resolve(
                new Response(
                  JSON.stringify({
                    protocol: 'nestvexa-live/1',
                    requestId: body.requestId,
                    component: { id, name, revision: body.revision + 1 },
                    snapshot: body.snapshot,
                    state,
                    html,
                  }),
                  { headers: { 'content-type': 'application/json' } },
                ),
              ),
            );
          });
        },
      });
      window.nvRenderingSession = {
        client,
        requests,
        errors,
        tasks,
        respond(index, html, state = { query: 'server', count: 1 }) {
          const reply = replies[index];
          if (!reply) throw new Error('Missing pending fixture reply');
          reply(html, state);
        },
      };
      client.mount();
      client.mount();
    },
    { html, ...(rootAttribute === undefined ? {} : { rootAttribute }) },
  );
}
async function start(action: string, selector = '#parent'): Promise<number> {
  return page.evaluate(
    ({ action, selector }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing action component');
      const session = window.nvRenderingSession;
      const index = session.tasks.length;
      session.tasks.push(
        session.client.call(element, action).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, code: String(Reflect.get(error, 'code')) }),
        ),
      );
      return index;
    },
    { action, selector },
  );
}
async function respond(index: number, html: string): Promise<void> {
  await page.evaluate(
    ({ index, html }) => window.nvRenderingSession.respond(index, html),
    { index, html },
  );
}
async function finish(index: number): Promise<TaskResult | undefined> {
  return page.evaluate(
    (index) => window.nvRenderingSession.tasks[index],
    index,
  );
}
async function metrics() {
  return page.evaluate(() => ({
    requests: window.nvRenderingSession.requests.map((request) => ({
      url: request.url,
      updates: request.body.updates,
      revision: request.body.revision,
      aborted: request.signal?.aborted ?? false,
    })),
    errors: window.nvRenderingSession.errors,
  }));
}

describe('client rendering and resource lifecycle in Chromium', () => {
  it.each(['number', 'email', 'file'])(
    'keeps revision usable when a focused text control changes to %s without caret support',
    async (type) => {
      await mount('<input id="changing" value="initial text">');
      await page.locator('#changing').focus();
      await page.locator('#changing').evaluate((element) => {
        (element as HTMLInputElement).setSelectionRange(2, 5);
      });
      const task = await start('refresh');
      const html = `<input id="changing" type="${type}">`;
      await respond(0, html);
      expect(await finish(task)).toEqual({ ok: true });
      expect(
        await page.locator('#parent').getAttribute('data-nv-revision'),
      ).toBe('1');
      expect((await metrics()).errors).toEqual([]);
      const next = await start('save');
      expect((await metrics()).requests[1]?.revision).toBe(1);
      await respond(1, html);
      expect(await finish(next)).toEqual({ ok: true });
      expect(
        await page.locator('#parent').getAttribute('data-nv-revision'),
      ).toBe('2');
    },
  );
  it('cancels a removed deferred click and attaches the replacement button once', async () => {
    await mount(
      '<div id="slot" nv:replace=""><button id="old" nv:click.debounce.100ms="obsolete">Old action</button></div>',
    );
    await page
      .locator('#old')
      .evaluate((element) => (element as HTMLButtonElement).click());
    const task = await start('refresh');
    await respond(
      0,
      '<div id="slot" nv:replace=""><button id="fresh" nv:click="fresh">Fresh action</button></div>',
    );
    expect(await finish(task)).toEqual({ ok: true });
    await page.clock.runFor(200);
    expect((await metrics()).requests.map((request) => request.url)).toEqual([
      `${base}/live/parent/refresh`,
    ]);
    await page
      .locator('#fresh')
      .evaluate((element) => (element as HTMLButtonElement).click());
    const requested = await metrics();
    expect(requested.requests.map((request) => request.url)).toEqual([
      `${base}/live/parent/refresh`,
      `${base}/live/parent/fresh`,
    ]);
    await respond(
      1,
      '<div id="slot" nv:replace=""><button id="fresh" nv:click="fresh">Fresh action</button></div>',
    );
    await page.clock.runFor(0);
    expect((await metrics()).errors).toEqual([]);
  });

  it.each([false, true])(
    'retains a newer dirty value only when an original control survives (survivor=%s)',
    async (survivor) => {
      const preserved = survivor
        ? '<input id="preserved" nv:model="query" value="initial">'
        : '';
      await mount(
        `<div id="slot" nv:replace=""><input id="edit" nv:model="query" value="initial"></div>${preserved}`,
      );
      const task = await start('refresh');
      await page.locator('#edit').focus();
      await page.locator('#edit').evaluate((element) => {
        (element as HTMLInputElement).value = 'newer draft';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const html = `<div id="slot" nv:replace=""><input id="edit" nv:model="query" value="server"></div>${preserved}`;
      await respond(0, html);
      expect(await finish(task)).toEqual({ ok: true });
      expect(
        await page
          .locator('#parent')
          .evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await page.keyboard.press('Tab');
      expect(
        await page
          .locator('#edit')
          .evaluate((element) => document.activeElement === element),
      ).toBe(true);
      expect(await page.locator('#parent').getAttribute('tabindex')).toBe(null);
      const next = await start('save');
      const sent = (await metrics()).requests[1];
      expect(sent?.updates).toEqual(survivor ? { query: 'newer draft' } : {});
      await respond(1, html);
      expect(await finish(next)).toEqual({ ok: true });
      expect((await metrics()).errors).toEqual([]);
    },
  );

  it.each(['remove', 'replace'])(
    'aborts an in-flight nested request before parent %s and discards late HTML',
    async (mode) => {
      const child =
        '<section id="child" data-nv-component="22222222-2222-4222-8222-222222222222" data-nv-name="child" data-nv-snapshot="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" data-nv-state="{&quot;query&quot;:&quot;initial&quot;,&quot;count&quot;:0}" data-nv-revision="0" data-nv-endpoint="/live/child" data-nv-csrf="host-csrf-012345678901234567890123456789"><output>Child initial</output></section>';
      await mount(
        `<div id="slot"${mode === 'replace' ? ' nv:replace=""' : ''}>${child}</div>`,
      );
      const nested = await start('slow', '#child');
      const parent = await start('refresh');
      await respond(
        1,
        mode === 'replace'
          ? '<div id="slot" nv:replace=""><p>Parent replaced child</p></div>'
          : '<p>Parent removed child</p>',
      );
      expect(await finish(parent)).toEqual({ ok: true });
      expect((await metrics()).requests[0]?.aborted).toBe(true);
      await respond(
        0,
        '<output id="stale-child">Stale child response</output>',
      );
      expect(await finish(nested)).toEqual({ ok: true });
      expect(await page.locator('#child').count()).toBe(0);
      expect(await page.locator('#stale-child').count()).toBe(0);
      expect((await metrics()).errors).toEqual([]);
    },
  );

  it.each(['nv:replace', 'nv:replace.self', 'conflict'])(
    'rejects unsafe replacement ownership at startup: %s',
    async (mode) => {
      await mount(
        mode === 'conflict'
          ? '<div nv:replace="" nv:ignore="">Conflicting owner</div>'
          : '<p>Root replacement</p>',
        mode === 'conflict' ? undefined : mode,
      );
      const result = await metrics();
      expect(result.requests).toEqual([]);
      expect(result.errors).toEqual([
        {
          code: 'DIRECTIVE',
          message:
            'Replacement requires one directive on an owned inner element',
        },
      ]);
      expect(await finish(await start('refresh'))).toEqual({
        ok: false,
        code: 'MARKER',
      });
    },
  );

  it('rejects duplicate incoming nested keys before mutating an earlier owned sibling', async () => {
    const initial =
      '<p id="earlier">Initial content</p><div id="slot"><span data-nv-key="one">Original</span></div>';
    await mount(initial);
    const task = await start('refresh');
    await respond(
      0,
      '<p id="earlier">Must not change</p><div id="slot"><span data-nv-key="duplicate">One</span><span data-nv-key="duplicate">Two</span></div>',
    );
    expect(await finish(task)).toEqual({ ok: false, code: 'HTML' });
    expect(await page.locator('#parent').innerHTML()).toBe(initial);
    expect(await page.locator('#parent').getAttribute('data-nv-revision')).toBe(
      '0',
    );
    const errors = (await metrics()).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('HTML');
  });
});
