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

interface OwnershipRequest {
  readonly url: string;
  readonly revision: number;
  readonly signal: AbortSignal | null;
}
interface OwnershipTask {
  readonly ok: boolean;
  readonly code?: string;
}
declare global {
  interface Window {
    nvOwnershipFixture: typeof import('../packages/client/dist/index.js');
    nvOwnershipSession: {
      client: ReturnType<
        typeof import('../packages/client/dist/index.js').createLiveClient
      >;
      requests: OwnershipRequest[];
      errors: string[];
      messages: string[];
      tasks: Promise<OwnershipTask>[];
      removals: number;
      respond(index: number, html?: string): void;
    };
  }
}
let browser: Browser;
let server: Server;
let page: Page;
let base: string;
let pageErrors: string[];
const marker = {
  'data-nv-component': '11111111-1111-4111-8111-111111111111',
  'data-nv-name': 'parent',
  'data-nv-endpoint': '/live/parent/',
  'data-nv-csrf': 'host-csrf-012345678901234567890123456789',
  'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'data-nv-revision': '00',
  'data-nv-state': ' { "query": "initial", "count": 0 } ',
};
const content =
  '<output id="status" nv:text="query" nv:cloak="">initial</output><button id="slow" type="button" class="ready" nv:click="slow" nv:loading.attr="disabled" nv:loading.class="working">Slow</button><button id="deferred" type="button" nv:click.debounce.100ms="deferred">Later</button><input id="edit" nv:model.live.debounce.100ms="query" value="initial">';

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Ownership transition fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; window.nvOwnershipFixture = client;",
        );
      return;
    }
    if (!/^\/[a-z-]+\.js$/.test(pathname)) {
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
    throw new Error('Missing ownership fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvOwnershipFixture'));
  await page.clock.install();
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvOwnershipSession?.client.dispose());
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

/** Real Chromium client behavior with deliberately controlled transport; not server conformance. */
async function mount(
  options: {
    rootIgnore?: boolean;
    ancestorIgnore?: boolean;
    child?: boolean;
    rejectOnAbort?: boolean;
    rejectTransport?: boolean;
  } = {},
) {
  await page.evaluate(
    ({ marker, content, options }) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Missing fixture host');
      const root = document.createElement('section');
      root.id = 'parent';
      for (const [name, value] of Object.entries(marker))
        root.setAttribute(name, value);
      root.innerHTML = content;
      if (options.rootIgnore) root.setAttribute('nv:ignore', '');
      const wrapper = document.createElement('div');
      wrapper.id = 'wrapper';
      if (options.ancestorIgnore) wrapper.setAttribute('nv:ignore', '');
      wrapper.append(root);
      main.append(wrapper);
      if (options.child) {
        const child = root.cloneNode(false) as HTMLElement;
        child.id = 'child';
        child.dataset['nvComponent'] = '22222222-2222-4222-8222-222222222222';
        child.dataset['nvName'] = 'child';
        child.dataset['nvEndpoint'] = '/live/child';
        child.innerHTML = '<p>Child initial</p>';
        root.append(child);
      }
      const requests: OwnershipRequest[] = [];
      const errors: string[] = [];
      const messages: string[] = [];
      const rejectOnAbort = options.rejectOnAbort === true;
      const rejectTransport = options.rejectTransport === true;
      const tasks: Promise<OwnershipTask>[] = [];
      const replies: ((html: string) => void)[] = [];
      const client = window.nvOwnershipFixture.createLiveClient({
        onError(error) {
          errors.push(String(Reflect.get(error, 'code')));
          messages.push(error.message);
        },
        fetch(url, options) {
          const body = JSON.parse(String(options?.body)) as {
            requestId: string;
            revision: number;
          };
          const name = new URL(String(url), location.href).pathname
            .split('/')
            .at(-2);
          const component =
            name === 'child' ? document.getElementById('child') : root;
          if (!component) throw new Error('Missing requested component');
          const id = component.getAttribute('data-nv-component');
          requests.push({
            url: String(url),
            revision: body.revision,
            signal: options?.signal ?? null,
          });
          return new Promise<Response>((resolve, reject) => {
            if (rejectTransport) {
              reject(new Error('Fixture transport failure'));
              return;
            }
            if (rejectOnAbort) {
              const abort = () =>
                reject(
                  new DOMException('Fixture request aborted', 'AbortError'),
                );
              if (options?.signal?.aborted) {
                abort();
                return;
              }
              options?.signal?.addEventListener('abort', abort, { once: true });
            }
            replies.push((html) =>
              resolve(
                new Response(
                  JSON.stringify({
                    protocol: 'nestvexa-live/1',
                    requestId: body.requestId,
                    component: { id, name, revision: body.revision + 1 },
                    snapshot: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                    state: { query: 'server', count: body.revision + 1 },
                    html,
                  }),
                  { headers: { 'content-type': 'application/json' } },
                ),
              ),
            );
          });
        },
      });
      window.nvOwnershipSession = {
        client,
        requests,
        errors,
        messages,
        tasks,
        removals: 0,
        respond(
          index,
          html = '<output id="status" nv:text="query">server</output>',
        ) {
          const reply = replies[index];
          if (!reply) throw new Error('Missing pending ownership response');
          reply(html);
        },
      };
      document.addEventListener('nestvexa:before-remove', () => {
        window.nvOwnershipSession.removals++;
      });
      client.mount();
    },
    { marker, content, options },
  );
}
async function start(action = 'slow', selector = '#parent'): Promise<number> {
  return page.evaluate(
    ({ action, selector }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing ownership root');
      const session = window.nvOwnershipSession;
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
async function finish(index: number) {
  return page.evaluate(
    (index) => window.nvOwnershipSession.tasks[index],
    index,
  );
}
async function respond(index: number, html?: string) {
  await page.evaluate(
    ({ index, html }) => window.nvOwnershipSession.respond(index, html),
    { index, html },
  );
}
async function metrics() {
  return page.evaluate(() => ({
    requests: window.nvOwnershipSession.requests.map((request) => ({
      url: request.url,
      revision: request.revision,
      aborted: request.signal?.aborted ?? false,
    })),
    errors: window.nvOwnershipSession.errors,
    removals: window.nvOwnershipSession.removals,
  }));
}

describe('registered client ownership transitions', () => {
  it('reports only marker invalidation when an event-driven transport rejects on abort', async () => {
    await mount({ rejectOnAbort: true });
    await page.locator('#slow').click();
    expect((await metrics()).requests).toHaveLength(1);
    await page
      .locator('#parent')
      .evaluate((element) => element.setAttribute('data-nv-name', 'changed'));
    await page.clock.runFor(500);
    const result = await metrics();
    expect(result.requests).toEqual([
      { url: `${base}/live/parent/slow`, revision: 0, aborted: true },
    ]);
    expect(result.errors).toEqual(['MARKER']);
    expect(
      await page.evaluate(() => window.nvOwnershipSession.messages),
    ).toEqual([
      'Live component marker changed; reload or reconcile authoritative server state before remounting',
    ]);
    await page.locator('#slow').click();
    await page.clock.runFor(500);
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).errors).toEqual(['MARKER']);
  });

  it('reports an ordinary event transport failure once without retrying', async () => {
    await mount({ rejectTransport: true });
    await page.locator('#slow').click();
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).errors).toEqual(['NETWORK']);
    expect(
      await page.evaluate(() => window.nvOwnershipSession.messages),
    ).toEqual([
      'Live request failed; reconcile server state before further actions',
    ]);
    expect(await page.locator('#slow').isDisabled()).toBe(false);
  });
  it('rejects nv:ignore on the component root without making requests', async () => {
    await mount({ rootIgnore: true });
    expect(await finish(await start())).toEqual({ ok: false, code: 'MARKER' });
    expect(await metrics()).toEqual({
      requests: [],
      errors: ['DIRECTIVE'],
      removals: 0,
    });
  });

  it('allows an independent Live root under a parent nv:ignore boundary', async () => {
    await mount({ ancestorIgnore: true });
    const task = await start();
    await respond(0);
    expect(await finish(task)).toEqual({ ok: true });
    expect((await metrics()).errors).toEqual([]);
  });

  it.each(
    Object.keys(marker).flatMap((attribute) =>
      ['remove', 'change'].map((mode) => ({ attribute, mode })),
    ),
  )(
    'invalidates changed registration once: $attribute $mode',
    async ({ attribute, mode }) => {
      await mount();
      const first = await start();
      const queued = await start('queued');
      await page.evaluate(
        ({ attribute, mode }) => {
          const root = document.getElementById('parent');
          if (!root) throw new Error('Missing ownership root');
          (document.getElementById('deferred') as HTMLButtonElement).click();
          const input = document.getElementById('edit') as HTMLInputElement;
          input.value = 'pending edit';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          if (mode === 'remove') root.removeAttribute(attribute);
          else root.setAttribute(attribute, 'externally changed');
        },
        { attribute, mode },
      );
      await page.clock.runFor(500);
      const result = await metrics();
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.aborted).toBe(true);
      expect(result.errors).toEqual(['MARKER']);
      expect(result.removals).toBe(0);
      expect(await page.locator('#parent').getAttribute('aria-busy')).toBe(
        null,
      );
      expect(await page.locator('#slow').isDisabled()).toBe(false);
      expect(await page.locator('#slow').getAttribute('class')).toBe('ready');
      await respond(0, '<p id="stale">Must not apply</p>');
      expect(await finish(first)).toEqual({ ok: true });
      expect(await finish(queued)).toEqual({ ok: true });
      expect(await page.locator('#stale').count()).toBe(0);
      expect(await finish(await start())).toEqual({
        ok: false,
        code: 'MARKER',
      });
      expect((await metrics()).errors).toEqual(['MARKER']);
    },
  );

  it('releases ownership and resources when a live root moves under an island', async () => {
    await mount();
    const first = await start();
    const queued = await start('queued');
    await page
      .locator('#wrapper')
      .evaluate((element) => element.setAttribute('data-nv-island', 'chart'));
    await page.clock.runFor(500);
    expect((await metrics()).requests).toEqual([
      { url: `${base}/live/parent/slow`, revision: 0, aborted: true },
    ]);
    expect((await metrics()).errors).toEqual([]);
    expect(await page.locator('#slow').isDisabled()).toBe(false);
    await respond(0, '<p id="stale">Late island-owned response</p>');
    expect(await finish(first)).toEqual({ ok: true });
    expect(await finish(queued)).toEqual({ ok: true });
    expect(await page.locator('#stale').count()).toBe(0);
    await page
      .locator('#wrapper')
      .evaluate((element) => element.removeAttribute('data-nv-island'));
    await page.clock.runFor(0);
    expect(await finish(await start())).toEqual({ ok: false, code: 'MARKER' });
    await page.evaluate(() => {
      window.nvOwnershipSession.client.dispose();
      window.nvOwnershipSession.client.mount();
    });
    const next = await start();
    await respond(1);
    expect(await finish(next)).toEqual({ ok: true });
  });

  it('guards marker changes synchronously before observer delivery', async () => {
    await mount();
    const result = await page.evaluate(async () => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing ownership root');
      root.setAttribute('data-nv-csrf', 'changed');
      try {
        await window.nvOwnershipSession.client.call(root, 'save');
        return 'accepted';
      } catch (error) {
        return error instanceof Error
          ? String(Reflect.get(error, 'code'))
          : 'UNKNOWN';
      }
    });
    expect(result).toBe('MARKER');
    expect((await metrics()).requests).toEqual([]);
    expect((await metrics()).errors).toEqual(['MARKER']);
  });

  it('accepts raw initial marker formatting and its own response writes across remounts', async () => {
    await mount();
    await page.clock.runFor(0);
    const first = await start();
    await respond(0, content);
    expect(await finish(first)).toEqual({ ok: true });
    await page.clock.runFor(0);
    expect(await page.locator('#parent').getAttribute('data-nv-revision')).toBe(
      '1',
    );
    const second = await start('save');
    await respond(1, content);
    expect(await finish(second)).toEqual({ ok: true });
    expect(
      (await metrics()).requests.map((request) => request.revision),
    ).toEqual([0, 1]);
    expect((await metrics()).errors).toEqual([]);
    await page.evaluate(() => {
      window.nvOwnershipSession.client.dispose();
      window.nvOwnershipSession.client.mount();
    });
    const third = await start('save');
    await respond(2, content);
    expect(await finish(third)).toEqual({ ok: true });
    expect(
      (await metrics()).requests.map((request) => request.revision),
    ).toEqual([0, 1, 2]);
  });

  it('requires explicit reconciliation before accepting restored external markers', async () => {
    await mount();
    await page
      .locator('#parent')
      .evaluate((element) => element.removeAttribute('data-nv-name'));
    await page.clock.runFor(0);
    await page.locator('#parent').evaluate((element, marker) => {
      for (const [name, value] of Object.entries(marker))
        element.setAttribute(name, value);
    }, marker);
    await page.clock.runFor(0);
    expect(await finish(await start())).toEqual({ ok: false, code: 'MARKER' });
    await page.evaluate(() => {
      window.nvOwnershipSession.client.dispose();
      window.nvOwnershipSession.client.mount();
    });
    const next = await start('save');
    await respond(0);
    expect(await finish(next)).toEqual({ ok: true });
    expect((await metrics()).errors).toEqual(['MARKER']);
  });

  it('does not adopt immutable marker changes made by an insertion hook', async () => {
    await mount();
    await page.evaluate(() =>
      document.addEventListener(
        'nestvexa:after-insert',
        () => {
          document
            .getElementById('parent')
            ?.setAttribute('data-nv-endpoint', '/different');
        },
        { once: true },
      ),
    );
    const first = await start();
    await respond(0, '<p id="new">Inserted content</p>');
    expect(await finish(first)).toEqual({ ok: true });
    expect(await page.locator('#parent').getAttribute('data-nv-revision')).toBe(
      '00',
    );
    expect((await metrics()).errors).toEqual(['MARKER']);
    expect(await finish(await start())).toEqual({ ok: false, code: 'MARKER' });
  });

  it('invalidates nested owned requests when their ancestor registration changes', async () => {
    await mount({ child: true });
    const nested = await start('slow', '#child');
    await page
      .locator('#parent')
      .evaluate((element) => element.removeAttribute('data-nv-component'));
    await page.clock.runFor(0);
    expect((await metrics()).requests[0]?.aborted).toBe(true);
    await respond(0, '<p id="stale-child">Must not apply</p>');
    expect(await finish(nested)).toEqual({ ok: true });
    expect(await page.locator('#stale-child').count()).toBe(0);
    expect((await metrics()).errors).toEqual(['MARKER']);
    expect(await finish(await start('save', '#child'))).toEqual({
      ok: false,
      code: 'MARKER',
    });
  });
  it('does not redirect a child call or event to the parent after its marker is removed', async () => {
    await mount({ child: true });
    const result = await page.evaluate(async () => {
      const child = document.getElementById('child');
      if (!child) throw new Error('Missing child root');
      child.removeAttribute('data-nv-component');
      try {
        await window.nvOwnershipSession.client.call(child, 'wrongParentAction');
        return 'accepted';
      } catch (error) {
        return error instanceof Error
          ? String(Reflect.get(error, 'code'))
          : 'UNKNOWN';
      }
    });
    expect(result).toBe('MARKER');
    await page.clock.runFor(0);
    await page.locator('#child').evaluate((element) => {
      element.innerHTML =
        '<button id="orphan-action" nv:click="wrongParentAction">Orphan action</button><input id="orphan-edit" nv:model="query" value="initial">';
      (element.querySelector('button') as HTMLButtonElement).click();
      const input = element.querySelector('input') as HTMLInputElement;
      input.value = 'Must not become parent state';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.clock.runFor(500);
    expect((await metrics()).requests).toEqual([]);
    expect((await metrics()).errors).toEqual(['MARKER']);
    const value = await page
      .locator('#parent')
      .evaluate((element) =>
        window.nvOwnershipSession.client.get(element, 'query'),
      );
    expect(value).toBe('initial');
    const parent = await start('safeParentAction');
    await respond(0, content);
    expect(await finish(parent)).toEqual({ ok: true });
    expect((await metrics()).requests[0]?.url).toBe(
      `${base}/live/parent/safeParentAction`,
    );
  });
});
