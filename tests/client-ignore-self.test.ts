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
  code?: string;
}
interface ClientRequest {
  url: string;
  body: RequestBody;
  signal: AbortSignal | null;
}
declare global {
  interface Window {
    nvIgnoreFixture: typeof import('../packages/client/dist/morph.js') &
      typeof import('../packages/client/dist/index.js');
    nvIgnoreSession: {
      client: ReturnType<
        typeof import('../packages/client/dist/index.js').createLiveClient
      >;
      requests: ClientRequest[];
      errors: { code: string | null; message: string }[];
      tasks: Promise<TaskResult>[];
      respond(
        index: number,
        html: string,
        state: Record<string, unknown>,
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
          '<!doctype html><html lang="en"><head><title>Wrapper ownership fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; import * as morph from '/morph.js'; window.nvIgnoreFixture = {...client, ...morph};",
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
    throw new Error('Missing wrapper fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvIgnoreFixture'));
  await page.clock.install();
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvIgnoreSession?.client.dispose());
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

/** Actual Chromium/client behavior with controlled transport, not Nest protocol conformance. */
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
      if (rootAttribute) root.setAttribute(rootAttribute, '');
      root.innerHTML = html;
      document.querySelector('main')?.append(root);
      const requests: ClientRequest[] = [];
      const errors: { code: string | null; message: string }[] = [];
      const tasks: Promise<TaskResult>[] = [];
      const replies: ((
        html: string,
        state: Record<string, unknown>,
      ) => void)[] = [];
      const client = window.nvIgnoreFixture.createLiveClient({
        onError(error) {
          errors.push({
            code:
              typeof Reflect.get(error, 'code') === 'string'
                ? String(Reflect.get(error, 'code'))
                : null,
            message: error.message,
          });
        },
        fetch(url, options) {
          const body = JSON.parse(String(options?.body)) as RequestBody;
          const name = new URL(String(url), location.href).pathname
            .split('/')
            .at(-2);
          const marker = document.querySelector(`[data-nv-name="${name}"]`);
          if (!marker || !name) throw new Error('Missing requested marker');
          const id = marker.getAttribute('data-nv-component');
          requests.push({
            url: String(url),
            body,
            signal: options?.signal ?? null,
          });
          return new Promise<Response>((resolve) => {
            // Late completion is intentional: cancellation must prevent stale DOM updates.
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
      window.nvIgnoreSession = {
        client,
        requests,
        errors,
        tasks,
        respond(index, html, state) {
          const reply = replies[index];
          if (!reply) throw new Error('Missing pending reply');
          reply(html, state);
        },
      };
      client.mount();
      client.mount();
    },
    { html, ...(rootAttribute === undefined ? {} : { rootAttribute }) },
  );
}
async function start(
  action = 'refresh',
  selector = '#parent',
): Promise<number> {
  return page.evaluate(
    ({ action, selector }) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error('Missing action target');
      const session = window.nvIgnoreSession;
      const index = session.tasks.length;
      session.tasks.push(
        session.client.call(target, action).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, code: String(Reflect.get(error, 'code')) }),
        ),
      );
      return index;
    },
    { action, selector },
  );
}
async function respond(
  index: number,
  html: string,
  state = { query: 'server', count: 1 },
): Promise<void> {
  await page.evaluate(
    ({ index, html, state }) =>
      window.nvIgnoreSession.respond(index, html, state),
    { index, html, state },
  );
}
async function finish(index: number): Promise<TaskResult | undefined> {
  return page.evaluate((index) => window.nvIgnoreSession.tasks[index], index);
}
async function requestCount(): Promise<number> {
  return page.evaluate(() => window.nvIgnoreSession.requests.length);
}
async function errors() {
  return page.evaluate(() => window.nvIgnoreSession.errors);
}

describe('wrapper-only ownership in real Chromium', () => {
  it('keeps host wrapper attributes while descendants retain text, refs, events and loading', async () => {
    const html =
      '<section id="wrapper" nv:ignore.self="" class="server" style="color:blue" aria-label="server"><output id="count" nv:text="count">0</output><button id="action" nv:click.stop="increase" nv:ref="action">Increase</button><span id="pending" nv:loading="">Pending</span></section>';
    await mount(html);
    await page.locator('#wrapper').evaluate((element) => {
      element.setAttribute('class', 'host');
      element.setAttribute('style', 'color: red');
      element.setAttribute('aria-label', 'host widget');
      element.setAttribute('data-host', 'local');
    });
    await page.locator('#action').click();
    await page.waitForFunction(
      () => window.nvIgnoreSession.requests.length === 1,
    );
    expect(await page.locator('#pending').isVisible()).toBe(true);
    await respond(0, html);
    await page.waitForFunction(
      () => document.querySelector('#count')?.textContent === '1',
    );
    expect(await page.locator('#wrapper').getAttribute('class')).toBe('host');
    expect(await page.locator('#wrapper').getAttribute('style')).toBe(
      'color: red',
    );
    expect(await page.locator('#wrapper').getAttribute('aria-label')).toBe(
      'host widget',
    );
    expect(await page.locator('#wrapper').getAttribute('data-host')).toBe(
      'local',
    );
    expect(await page.locator('#pending').isVisible()).toBe(false);
    expect(
      await page.evaluate(() => {
        const root = document.querySelector('#parent');
        return (
          root &&
          window.nvIgnoreSession.client.refs(root).get('action') ===
            document.querySelector('#action')
        );
      }),
    ).toBe(true);
    expect(await errors()).toEqual([]);
  });

  it('allows frozen event/text/ref directives on the wrapper itself', async () => {
    const html =
      '<button id="wrapper" nv:ignore.self="" nv:click="increase" nv:text="count" nv:ref="wrapper" class="server">0</button>';
    await mount(html);
    await page.locator('#wrapper').evaluate((element) => {
      element.setAttribute('class', 'host');
    });
    await page.locator('#wrapper').click();
    await page.waitForFunction(
      () => window.nvIgnoreSession.requests.length === 1,
    );
    await respond(0, html);
    await page.waitForFunction(
      () => document.querySelector('#wrapper')?.textContent === '1',
    );
    expect(await page.locator('#wrapper').getAttribute('class')).toBe('host');
    expect(await errors()).toEqual([]);
  });

  it('queues repeated descendant actions against successive committed revisions', async () => {
    const html =
      '<section id="wrapper" nv:ignore.self=""><button id="action" nv:click="increase">Increase</button><output id="count" nv:text="count">0</output></section>';
    await mount(html);
    await page.locator('#action').click();
    await page.waitForFunction(
      () => window.nvIgnoreSession.requests.length === 1,
    );
    await page.locator('#action').click();
    expect(await requestCount()).toBe(1);
    await respond(0, html);
    await page.waitForFunction(
      () => window.nvIgnoreSession.requests.length === 2,
    );
    await respond(1, html, { query: 'server', count: 2 });
    await page.waitForFunction(
      () => document.querySelector('#count')?.textContent === '2',
    );
    expect(
      await page.evaluate(() =>
        window.nvIgnoreSession.requests.map((request) => request.body.revision),
      ),
    ).toEqual([0, 1]);
    expect(await errors()).toEqual([]);
  });

  it('preserves a newer descendant model draft, focus and caret against an earlier response', async () => {
    const html =
      '<section id="wrapper" nv:ignore.self=""><input id="edit" nv:model="query" value="initial"><output id="value" nv:text="query">initial</output></section>';
    await mount(html);
    const task = await start();
    await page.locator('#edit').fill('newer local draft');
    await page
      .locator('#edit')
      .evaluate((element) =>
        (element as HTMLInputElement).setSelectionRange(3, 8),
      );
    await respond(0, html);
    expect(await finish(task)).toEqual({ ok: true });
    expect(await page.locator('#edit').inputValue()).toBe('newer local draft');
    expect(await page.locator('#value').textContent()).toBe(
      'newer local draft',
    );
    expect(
      await page.locator('#edit').evaluate((element) => ({
        active: document.activeElement === element,
        start: (element as HTMLInputElement).selectionStart,
        end: (element as HTMLInputElement).selectionEnd,
      })),
    ).toEqual({ active: true, start: 3, end: 8 });
    const next = await start('save');
    expect(
      await page.evaluate(
        () => window.nvIgnoreSession.requests[1]?.body.updates,
      ),
    ).toEqual({ query: 'newer local draft' });
    await respond(1, html);
    expect(await finish(next)).toEqual({ ok: true });
    expect(await errors()).toEqual([]);
  });

  it('keeps unbound descendant drafts private across wrapper projection', async () => {
    const html =
      '<section id="wrapper" nv:ignore.self=""><input id="local" name="local" value="initial"><textarea id="memo">initial memo</textarea></section>';
    await mount(html);
    await page.locator('#local').fill('private local draft');
    await page.locator('#memo').fill('private local memo');
    const task = await start();
    await respond(0, html);
    expect(await finish(task)).toEqual({ ok: true });
    expect(await page.locator('#local').inputValue()).toBe(
      'private local draft',
    );
    expect(await page.locator('#memo').inputValue()).toBe('private local memo');
    expect(
      await page.evaluate(
        () => window.nvIgnoreSession.requests[0]?.body.updates,
      ),
    ).toEqual({});
    expect(
      await page.locator('#parent').getAttribute('data-nv-state'),
    ).not.toContain('private local');
    expect(await errors()).toEqual([]);
  });

  it.each(['value', 'addition', 'removal'])(
    'rejects a late retained directive %s before mutating any live sibling',
    async (mode) => {
      const initial =
        '<p id="early">before</p><section id="wrapper" nv:ignore.self="" nv:click="increase"><p>inside</p></section>';
      await mount(initial);
      const task = await start();
      const directives =
        mode === 'value'
          ? 'nv:click="remove"'
          : mode === 'addition'
            ? 'nv:click="increase" nv:ref="added"'
            : '';
      await respond(
        0,
        `<p id="early">must not change</p><section id="wrapper" nv:ignore.self="" ${directives}><p>changed</p></section>`,
      );
      expect(await finish(task)).toEqual({ ok: false, code: 'DIRECTIVE' });
      expect(await page.locator('#parent').innerHTML()).toBe(initial);
      expect((await errors()).map((error) => error.message)).toEqual([
        'Retained nv:ignore.self directive configuration cannot change; replace its key or an ancestor',
      ]);
    },
  );

  it.each([
    'nv:bind="title:query"',
    'nv:show="count"',
    'nv:dirty=""',
    'nv:cloak=""',
    'nv:model="query"',
    'nv:loading=""',
    'nv:loading.class="waiting"',
    'nv:loading.attr="aria-busy"',
    'nv:target="increase"',
    'nv:replace=""',
    'nv:replace.self=""',
  ])('rejects a same-wrapper competing writer: %s', async (attribute) => {
    await mount(`<div id="wrapper" nv:ignore.self="" ${attribute}>Text</div>`);
    expect(await requestCount()).toBe(0);
    expect(await errors()).toHaveLength(1);
    expect((await errors())[0]?.code).toBe('DIRECTIVE');
    expect(await finish(await start())).toEqual({ ok: false, code: 'MARKER' });
  });

  it.each([
    '<input nv:ignore.self="">',
    '<textarea nv:ignore.self="">Text</textarea>',
    '<select nv:ignore.self=""><option>A</option></select>',
    '<select><option nv:ignore.self="">A</option></select>',
    '<select><optgroup nv:ignore.self=""><option>A</option></optgroup></select>',
    '<div nv:ignore.self="" contenteditable="true">Editable</div>',
    '<div contenteditable=""><span nv:ignore.self="">Inherited editable</span></div>',
    '<div contenteditable="true"><section nv:ignore.self="" contenteditable="false"><p>Blocked by editable ancestor</p></section></div>',
    '<section nv:ignore.self="" data-nv-island="chart">Island</section>',
    '<div nv:ignore.self="" nv:ignore="">Conflicting ignore</div>',
    '<div nv:ignore.self="expression">Not data</div>',
    '<div nv:ignore.self.once="">Unknown modifier</div>',
  ])('rejects unsupported wrapper ownership at startup: %s', async (html) => {
    await mount(html);
    expect(await requestCount()).toBe(0);
    expect(await errors()).toHaveLength(1);
    expect((await errors())[0]?.code).toBe('DIRECTIVE');
  });

  it('rejects wrapper-only ownership on the Live root', async () => {
    await mount('<p>Root content</p>', 'nv:ignore.self');
    expect(await errors()).toHaveLength(1);
    expect((await errors())[0]?.code).toBe('DIRECTIVE');
    expect(await finish(await start())).toEqual({ ok: false, code: 'MARKER' });
  });

  it('morphs a standalone explicitly non-editable wrapper while retaining its attributes', async () => {
    await mount(
      '<section id="wrapper" nv:ignore.self="" contenteditable="false" class="initial"><p id="old">Old child</p></section>',
    );
    const task = await start();
    await respond(
      0,
      '<section id="wrapper" nv:ignore.self="" contenteditable="false" class="server"><p id="fresh">New child</p></section>',
    );
    expect(await finish(task)).toEqual({ ok: true });
    expect(await page.locator('#old').count()).toBe(0);
    expect(await page.locator('#fresh').textContent()).toBe('New child');
    expect(await page.locator('#wrapper').getAttribute('class')).toBe(
      'initial',
    );
    expect(await errors()).toEqual([]);
  });

  it.each(['enter', 'leave'])(
    'replaces the wrapper and native state when ownership modes %s',
    async (mode) => {
      const initial = `<section id="wrapper"${mode === 'leave' ? ' nv:ignore.self=""' : ''}><input id="edit" value="initial"></section>`;
      await mount(initial);
      await page.locator('#edit').fill('local');
      await page
        .locator('#wrapper')
        .evaluate((element) => Reflect.set(window, 'previousWrapper', element));
      const task = await start();
      await respond(
        0,
        `<section id="wrapper"${mode === 'enter' ? ' nv:ignore.self=""' : ''}><input id="edit" value="initial"></section>`,
      );
      expect(await finish(task)).toEqual({ ok: true });
      expect(
        await page
          .locator('#wrapper')
          .evaluate(
            (element) => Reflect.get(window, 'previousWrapper') === element,
          ),
      ).toBe(false);
      expect(await page.locator('#edit').inputValue()).toBe('initial');
      expect(await errors()).toEqual([]);
    },
  );

  it('keeps old whole-ignore opaque until an ancestor is replaced', async () => {
    const initial =
      '<section id="outer"><div id="wrapper" nv:ignore=""><input id="edit" value="initial"></div></section>';
    await mount(initial);
    await page.locator('#edit').fill('local');
    const task = await start();
    await respond(
      0,
      '<section id="outer"><div id="wrapper" nv:ignore.self=""><input id="edit" value="server"></div></section>',
    );
    expect(await finish(task)).toEqual({ ok: true });
    expect(await page.locator('#wrapper').getAttribute('nv:ignore')).toBe('');
    expect(await page.locator('#edit').inputValue()).toBe('local');
    const replaced = await start();
    await respond(
      1,
      '<section id="outer" nv:replace=""><div id="wrapper" nv:ignore.self=""><input id="edit" value="server"></div></section>',
    );
    expect(await finish(replaced)).toEqual({ ok: true });
    expect(await page.locator('#wrapper').getAttribute('nv:ignore.self')).toBe(
      '',
    );
    expect(await page.locator('#edit').inputValue()).toBe('server');
    expect(await errors()).toEqual([]);
  });

  it('uses retained form-wrapper IDs for explicit and inherited native radio owners', async () => {
    const body = (checked: boolean) =>
      `<form data-nv-key="stable-form" id="server-form" nv:ignore.self=""><input id="a" type="radio" name="choice" form="host-form" value="a"${checked ? ' checked' : ''}><input id="b" type="radio" name="choice" value="b"></form>`;
    await mount(body(false));
    await page.locator('form').evaluate((element) => {
      element.id = 'host-form';
    });
    expect(
      await page
        .locator('#a')
        .evaluate((element) => (element as HTMLInputElement).form?.id),
    ).toBe('host-form');
    await page.locator('#b').check();
    const task = await start();
    await respond(0, body(false));
    expect(await finish(task)).toEqual({ ok: true });
    expect(await page.locator('#b').isChecked()).toBe(true);
    const reset = await start();
    await respond(1, body(true));
    expect(await finish(reset)).toEqual({ ok: true });
    expect(await page.locator('form').getAttribute('id')).toBe('host-form');
    expect(await page.locator('#a').isChecked()).toBe(true);
    expect(await page.locator('#b').isChecked()).toBe(false);
    expect(await errors()).toEqual([]);
  });

  it('retains nested Live, island and whole-ignore subtrees while owned siblings update', async () => {
    const child =
      '<section id="child" data-nv-component="22222222-2222-4222-8222-222222222222" data-nv-name="child" data-nv-snapshot="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" data-nv-state="{&quot;query&quot;:&quot;initial&quot;,&quot;count&quot;:0}" data-nv-revision="0" data-nv-endpoint="/live/child" data-nv-csrf="host-csrf-012345678901234567890123456789"><output id="child-content">Child</output></section>';
    const html = (changed: boolean) =>
      `<section id="wrapper" nv:ignore.self=""><output id="count" nv:text="count">0</output>${child}<div id="island" data-nv-island="chart">${changed ? 'server' : 'local island'}</div><div id="ignored" nv:ignore="">${changed ? 'server' : 'local ignored'}</div></section>`;
    await mount(html(false));
    const nested = await start('slow', '#child');
    const parent = await start();
    await respond(1, html(true));
    expect(await finish(parent)).toEqual({ ok: true });
    expect(await page.locator('#island').textContent()).toBe('local island');
    expect(await page.locator('#ignored').textContent()).toBe('local ignored');
    expect(
      await page.evaluate(
        () => window.nvIgnoreSession.requests[0]?.signal?.aborted,
      ),
    ).toBe(false);
    await respond(0, '<output id="child-content">Child completed</output>');
    expect(await finish(nested)).toEqual({ ok: true });
    expect(await page.locator('#child-content').textContent()).toBe(
      'Child completed',
    );
    expect(await errors()).toEqual([]);
  });

  it('cancels descendant debounce work when a self wrapper is removed', async () => {
    await mount(
      '<section id="wrapper" nv:ignore.self=""><button id="later" nv:click.debounce.100ms="obsolete">Later</button></section>',
    );
    await page
      .locator('#later')
      .evaluate((element) => (element as HTMLElement).click());
    const task = await start();
    await respond(0, '<p id="replacement">Removed wrapper</p>');
    expect(await finish(task)).toEqual({ ok: true });
    await page.clock.runFor(500);
    expect(await requestCount()).toBe(1);
    expect(await errors()).toEqual([]);
  });

  it('aborts a nested request and excludes its late response after wrapper removal', async () => {
    const child =
      '<section id="child" data-nv-component="22222222-2222-4222-8222-222222222222" data-nv-name="child" data-nv-snapshot="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" data-nv-state="{&quot;query&quot;:&quot;initial&quot;,&quot;count&quot;:0}" data-nv-revision="0" data-nv-endpoint="/live/child" data-nv-csrf="host-csrf-012345678901234567890123456789"><output>Child</output></section>';
    await mount(`<section id="wrapper" nv:ignore.self="">${child}</section>`);
    const nested = await start('slow', '#child');
    const parent = await start();
    await respond(1, '<p id="replacement">Removed</p>');
    expect(await finish(parent)).toEqual({ ok: true });
    expect(
      await page.evaluate(
        () => window.nvIgnoreSession.requests[0]?.signal?.aborted,
      ),
    ).toBe(true);
    await respond(0, '<output id="stale">Late</output>');
    expect(await finish(nested)).toEqual({ ok: true });
    expect(await page.locator('#stale').count()).toBe(0);
    expect(await errors()).toEqual([]);
  });

  it('retains the same keyed wrapper across mixed keyed and unkeyed sibling moves', async () => {
    await mount(
      '<p>unkeyed first</p><section data-nv-key="wrapper" id="wrapper" nv:ignore.self="" class="server"><output id="count" nv:text="count">0</output></section><p>unkeyed last</p>',
    );
    await page.locator('#wrapper').evaluate((element) => {
      element.setAttribute('class', 'host');
      Reflect.set(window, 'previousWrapper', element);
    });
    const task = await start();
    await respond(
      0,
      '<section data-nv-key="wrapper" id="wrapper" nv:ignore.self="" class="changed"><output id="count" nv:text="count">0</output></section><p>after moved wrapper</p><p>last sibling</p>',
    );
    expect(await finish(task)).toEqual({ ok: true });
    expect(
      await page
        .locator('#parent')
        .locator(':scope > *')
        .evaluateAll((elements) => elements.map((element) => element.tagName)),
    ).toEqual(['SECTION', 'P', 'P']);
    expect(
      await page
        .locator('#wrapper')
        .evaluate(
          (element) => Reflect.get(window, 'previousWrapper') === element,
        ),
    ).toBe(true);
    expect(await page.locator('#wrapper').getAttribute('class')).toBe('host');
    expect(await page.locator('#count').textContent()).toBe('1');
    expect(await errors()).toEqual([]);
  });
});
