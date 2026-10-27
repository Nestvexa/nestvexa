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
interface ResetRequest {
  url: string;
  body: RequestBody;
  signal: AbortSignal | null;
}
interface TaskResult {
  ok: boolean;
  code: string | null;
}
interface MountOptions {
  html?: string;
  external?: string;
  elementRoot?: boolean;
  state?: Record<string, unknown>;
}
declare global {
  interface Window {
    nvResetFixture: typeof import('../packages/client/dist/index.js');
    nvResetSession: {
      client: ReturnType<
        typeof import('../packages/client/dist/index.js').createLiveClient
      >;
      requests: ResetRequest[];
      results: (TaskResult | null)[];
      errors: { code: string | null; message: string }[];
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
const defaultState = {
  query: 'initial',
  note: 'memo',
  enabled: true,
  choice: 'a',
  quantity: 1,
  other: 'outside',
};
const defaultMarkup =
  '<form id="editor"><label for="edit">Query</label><input id="edit" nv:model="query" value="initial"><button type="reset">Reset fields</button></form><output id="preview" nv:text="query">initial</output><span id="dirty" nv:dirty="query" hidden>Dirty query</span>';

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Native reset client fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; window.nvResetFixture = client;",
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
    throw new Error('Missing reset fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvResetFixture'));
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvResetSession?.client.dispose());
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

/** Actual Chromium reset/default behavior with controlled fetch; not Nest conformance evidence. */
async function mount(options: MountOptions = {}): Promise<void> {
  await page.evaluate(
    ({ html, external, elementRoot, state }) => {
      const root = document.createElement('section');
      root.id = 'parent';
      for (const [name, value] of Object.entries({
        'data-nv-component': '11111111-1111-4111-8111-111111111111',
        'data-nv-name': 'parent',
        'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'data-nv-revision': '0',
        'data-nv-endpoint': '/live/parent',
        'data-nv-csrf': 'reset-fixture-012345678901234567890123456789',
        'data-nv-state': JSON.stringify(state),
      }))
        root.setAttribute(name, value);
      root.innerHTML = html;
      document.querySelector('main')?.append(root);
      if (external) document.body.insertAdjacentHTML('beforeend', external);
      const requests: ResetRequest[] = [];
      const results: (TaskResult | null)[] = [];
      const errors: { code: string | null; message: string }[] = [];
      const replies: ((
        html: string,
        state: Record<string, unknown>,
      ) => void)[] = [];
      const client = window.nvResetFixture.createLiveClient({
        ...(elementRoot ? { root } : {}),
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
          const body = JSON.parse(String(init?.body)) as RequestBody;
          const owner = root;
          requests.push({
            url: String(url),
            body,
            signal: init?.signal ?? null,
          });
          return new Promise<Response>((resolve) => {
            replies.push((html, state) =>
              resolve(
                new Response(
                  JSON.stringify({
                    protocol: 'nestvexa-live/1',
                    requestId: body.requestId,
                    component: {
                      id: owner.getAttribute('data-nv-component'),
                      name: owner.getAttribute('data-nv-name'),
                      revision: body.revision + 1,
                    },
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
      window.nvResetSession = {
        client,
        requests,
        results,
        errors,
        respond(index, html, state) {
          const reply = replies[index];
          if (!reply) throw new Error('Missing reset reply');
          reply(html, state);
        },
      };
      client.mount();
    },
    {
      html: options.html ?? defaultMarkup,
      external: options.external ?? '',
      elementRoot: options.elementRoot ?? false,
      state: options.state ?? defaultState,
    },
  );
}
async function reset(selector = '#editor'): Promise<void> {
  await page.locator(selector).evaluate((element) => {
    if (!(element instanceof HTMLFormElement))
      throw new Error('Missing native form');
    HTMLFormElement.prototype.reset.call(element);
  });
  await page.clock.runFor(0);
}
async function get(field = 'query'): Promise<unknown> {
  return page.evaluate((field) => {
    const root = document.getElementById('parent');
    if (!root) throw new Error('Missing root');
    return window.nvResetSession.client.get(root, field);
  }, field);
}
async function start(action = 'save'): Promise<number> {
  return page.evaluate((action) => {
    const root = document.getElementById('parent');
    if (!root) throw new Error('Missing reset owner');
    const session = window.nvResetSession;
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
            error instanceof Error ? String(Reflect.get(error, 'code')) : null,
        };
      },
    );
    return index;
  }, action);
}
async function respond(
  index: number,
  html = defaultMarkup,
  state: Record<string, unknown> = defaultState,
): Promise<void> {
  await page.evaluate(
    ({ index, html, state }) =>
      window.nvResetSession.respond(index, html, state),
    { index, html, state },
  );
  await page.clock.runFor(0);
}
async function metrics() {
  return page.evaluate(() => ({
    requests: window.nvResetSession.requests.map((request) => ({
      url: request.url,
      body: request.body,
    })),
    errors: window.nvResetSession.errors,
    results: window.nvResetSession.results,
  }));
}

describe('native form reset reconciliation', () => {
  it('reconciles reset browser values with public draft state before another action', async () => {
    await mount();
    await page.locator('#edit').fill('discarded draft');
    expect(await get()).toBe('discarded draft');
    await reset();
    expect(await page.locator('#edit').inputValue()).toBe('initial');
    expect(await get()).toBe('initial');
    expect(await page.locator('#preview').textContent()).toBe('initial');
    expect(await page.locator('#dirty').isHidden()).toBe(true);
    await start();
    const requests = (await metrics()).requests;
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.body.updates['query']).not.toBe('discarded draft');
  });

  it('handles the native reset button without dispatching an action or synchronization', async () => {
    await mount();
    await page.locator('#edit').fill('discarded');
    await page.getByRole('button', { name: 'Reset fields' }).click();
    await page.clock.runFor(1);
    // Observe bindings before get(), which can itself flush a completed reset.
    expect(await page.locator('#preview').textContent()).toBe('initial');
    expect(await page.locator('#dirty').isHidden()).toBe(true);
    expect(await get()).toBe('initial');
    expect((await metrics()).requests).toEqual([]);
    expect((await metrics()).errors).toEqual([]);
  });

  it('leaves local state and a model timer intact when a later listener cancels reset', async () => {
    const html = defaultMarkup.replace(
      'nv:model="query"',
      'nv:model.live.debounce.100ms="query"',
    );
    await mount({ html });
    await page.locator('#edit').fill('keep canceled draft');
    await page.evaluate(() =>
      document.addEventListener('reset', (event) => event.preventDefault(), {
        once: true,
      }),
    );
    await reset();
    expect(await page.locator('#edit').inputValue()).toBe(
      'keep canceled draft',
    );
    expect(await get()).toBe('keep canceled draft');
    await page.clock.runFor(100);
    expect((await metrics()).requests[0]?.body.updates['query']).toBe(
      'keep canceled draft',
    );
  });

  it('cancels pending live synchronization without automatically sending reset values', async () => {
    const html = defaultMarkup.replace(
      'nv:model="query"',
      'nv:model.live.debounce.100ms="query"',
    );
    await mount({ html });
    await page.locator('#edit').fill('discarded scheduled draft');
    await reset();
    await page.clock.runFor(1000);
    expect((await metrics()).requests).toEqual([]);
    expect(await get()).toBe('initial');
  });

  it('keeps edits belonging to another form', async () => {
    await mount({
      html:
        defaultMarkup +
        '<form id="other-form"><input id="other-edit" nv:model="other" value="outside"></form>',
    });
    await page.locator('#edit').fill('discard query');
    await page.locator('#other-edit').fill('keep other draft');
    await reset();
    expect(await get()).toBe('initial');
    expect(await get('other')).toBe('keep other draft');
    expect(await page.locator('#other-edit').inputValue()).toBe(
      'keep other draft',
    );
  });

  it('reconciles an owned control explicitly associated from outside its form', async () => {
    await mount({
      html: '<form id="editor"></form><input id="edit" form="editor" nv:model="query" value="initial">',
    });
    await page.locator('#edit').fill('discarded associated draft');
    await reset();
    expect(await get()).toBe('initial');
    expect(await page.locator('#edit').inputValue()).toBe('initial');
    expect((await metrics()).requests).toEqual([]);
  });

  it('uses actual form association rather than a control ancestor', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" form="owner" nv:model="query" value="initial"></form><form id="owner"></form>',
    });
    await page.locator('#edit').fill('still edited');
    await reset();
    expect(await get()).toBe('still edited');
    expect(await page.locator('#edit').inputValue()).toBe('still edited');
    await reset('#owner');
    expect(await get()).toBe('initial');
  });

  it('reconciles disabled controls that the native reset algorithm still resets', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" nv:model="query" value="initial" disabled></form>',
    });
    await page.evaluate(() => {
      const root = document.getElementById('parent');
      const input = document.getElementById('edit');
      if (!root || !(input instanceof HTMLInputElement))
        throw new Error('Missing disabled fixture');
      window.nvResetSession.client.set(root, 'query', 'programmatic draft');
      input.value = 'programmatic draft';
    });
    await reset();
    expect(await get()).toBe('initial');
    expect(await page.locator('#edit').inputValue()).toBe('initial');
    expect((await metrics()).requests).toEqual([]);
  });

  it('does not expose a whole-ignored native control as a Live reset update', async () => {
    await mount({
      html: defaultMarkup.replace(
        '</form>',
        '<div nv:ignore=""><input id="ignored-edit" nv:model="other" value="outside"></div></form>',
      ),
    });
    await page.locator('#edit').fill('discarded own draft');
    await page.locator('#ignored-edit').fill('ignored native draft');
    await page.evaluate(() => {
      const root = document.getElementById('parent');
      if (!root) throw new Error('Missing root');
      window.nvResetSession.client.set(
        root,
        'other',
        'programmatic public draft',
      );
    });
    await reset();
    expect(await get()).toBe('initial');
    expect(await get('other')).toBe('programmatic public draft');
    expect(await page.locator('#ignored-edit').inputValue()).toBe('outside');
  });

  it.each([
    {
      label: 'textarea',
      html: '<textarea id="edit" nv:model="note">memo</textarea>',
      field: 'note',
      edit: 'draft memo',
      value: 'memo',
    },
    {
      label: 'single select',
      html: '<select id="edit" nv:model="choice"><option value="a" selected>A</option><option value="b">B</option></select>',
      field: 'choice',
      edit: 'b',
      value: 'a',
    },
    {
      label: 'numeric cast',
      html: '<input id="edit" nv:model.number="quantity" value="1">',
      field: 'quantity',
      edit: '12.5',
      value: 1,
    },
  ])(
    'reconciles native $label reset semantics',
    async ({ label, html, field, edit, value }) => {
      await mount({ html: `<form id="editor">${html}</form>` });
      if (label === 'single select')
        await page.locator('#edit').selectOption(edit);
      else await page.locator('#edit').fill(edit);
      await reset();
      expect(await get(field)).toBe(value);
      expect((await metrics()).errors).toEqual([]);
    },
  );

  it('reconciles native checkbox checkedness after reset', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" type="checkbox" nv:model="enabled" checked></form>',
    });
    await page.locator('#edit').uncheck();
    expect(await get('enabled')).toBe(false);
    await reset();
    expect(await page.locator('#edit').isChecked()).toBe(true);
    expect(await get('enabled')).toBe(true);
  });

  it('reconciles a checked radio without using an unchecked sibling as a state delta', async () => {
    await mount({
      html: '<form id="editor"><input id="a" type="radio" name="choice" nv:model="choice" value="a" checked><input id="b" type="radio" name="choice" nv:model="choice" value="b"></form>',
    });
    await page.locator('#b').check();
    expect(await get('choice')).toBe('b');
    await reset();
    expect(await page.locator('#a').isChecked()).toBe(true);
    expect(await get('choice')).toBe('a');
    expect((await metrics()).errors).toEqual([]);
  });

  it('clears invalid local conversion after reset to a valid numeric default', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" nv:model.number="quantity" value="1"></form>',
    });
    await page.locator('#edit').fill('invalid');
    expect((await metrics()).errors).toHaveLength(1);
    await reset();
    expect(await get('quantity')).toBe(1);
    await start();
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).errors).toHaveLength(1);
  });

  it('cancels a reset with an invalid numeric default and preserves the current valid draft', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" nv:model.number="quantity" value="invalid-default"></form>',
    });
    await page.locator('#edit').fill('2');
    await reset();
    expect(await page.locator('#edit').inputValue()).toBe('2');
    expect(await get('quantity')).toBe(2);
    expect((await metrics()).requests).toEqual([]);
    expect(
      (await metrics()).errors.some((error) => error.code === 'DIRECTIVE'),
    ).toBe(true);
    await start();
    expect((await metrics()).requests[0]?.body.updates['quantity']).toBe(2);
  });

  it('suspends transport if a later reset listener makes the native result unrepresentable', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" nv:model.number="quantity" value="1"></form>',
    });
    await page.locator('#edit').fill('2');
    await page.evaluate(() =>
      document.addEventListener(
        'reset',
        () => {
          const input = document.getElementById('edit');
          if (input instanceof HTMLInputElement) input.defaultValue = 'invalid';
        },
        { once: true },
      ),
    );
    await reset();
    expect(await page.locator('#edit').inputValue()).toBe('invalid');
    expect(await get('quantity')).toBe(2);
    const task = await start();
    expect((await metrics()).requests).toEqual([]);
    expect((await metrics()).results[task]).toEqual({
      ok: false,
      code: 'DIRECTIVE',
    });
    expect((await metrics()).errors).toHaveLength(1);
  });

  it('does not let a getter inside native reset dispatch preempt a later document veto', async () => {
    await mount();
    await page.locator('#edit').fill('retained draft');
    await page.locator('#editor').evaluate((element) => {
      element.addEventListener(
        'reset',
        () => {
          const root = document.getElementById('parent');
          if (!root) throw new Error('Missing reset owner');
          root.setAttribute(
            'data-read-during-reset',
            String(window.nvResetSession.client.get(root, 'query')),
          );
        },
        { once: true },
      );
      document.addEventListener('reset', (event) => event.preventDefault(), {
        once: true,
      });
    });
    await page.getByRole('button', { name: 'Reset fields' }).click();
    await page.clock.runFor(1);
    expect(
      await page.locator('#parent').getAttribute('data-read-during-reset'),
    ).toBe('retained draft');
    expect(await page.locator('#edit').inputValue()).toBe('retained draft');
    expect(await page.locator('#preview').textContent()).toBe('retained draft');
    expect(await page.locator('#dirty').isHidden()).toBe(false);
    expect((await metrics()).requests).toEqual([]);
    expect((await metrics()).errors).toEqual([]);
  });

  it('ends a stale composition session so new edits are not ignored after reset', async () => {
    await mount();
    await page.locator('#edit').evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );
      if (!(element instanceof HTMLInputElement))
        throw new Error('Missing composing input');
      element.value = 'in progress';
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, isComposing: true }),
      );
    });
    await reset();
    await page.locator('#edit').fill('after composition reset');
    expect(await get()).toBe('after composition reset');
  });

  it('versions reset values as newer edits than an in-flight request', async () => {
    await mount();
    await page.locator('#edit').fill('sent draft');
    const task = await start('save');
    expect((await metrics()).requests[0]?.body.updates['query']).toBe(
      'sent draft',
    );
    await reset();
    await respond(0, defaultMarkup.replaceAll('initial', 'sent draft'), {
      ...defaultState,
      query: 'sent draft',
    });
    expect((await metrics()).results[task]).toEqual({ ok: true, code: null });
    expect(await page.locator('#edit').inputValue()).toBe('initial');
    expect(await get()).toBe('initial');
    await start('save');
    expect((await metrics()).requests[1]?.body.updates['query']).toBe(
      'initial',
    );
  });

  it('applies a reset before an action queued synchronously after form.reset returns', async () => {
    await mount();
    await page.locator('#edit').fill('discarded before same-turn action');
    await page.evaluate(() => {
      const form = document.getElementById('editor');
      const root = document.getElementById('parent');
      if (!(form instanceof HTMLFormElement) || !root)
        throw new Error('Missing same-turn fixture');
      HTMLFormElement.prototype.reset.call(form);
      void window.nvResetSession.client
        .call(root, 'save')
        .catch(() => undefined);
    });
    await page.clock.runFor(0);
    expect((await metrics()).requests).toHaveLength(1);
    expect((await metrics()).requests[0]?.body.updates['query']).not.toBe(
      'discarded before same-turn action',
    );
    expect(await get()).toBe('initial');
  });

  it('flushes the completed native reset before a synchronous public state read', async () => {
    await mount();
    await page.locator('#edit').fill('discarded before synchronous get');
    const value = await page.evaluate(() => {
      const form = document.getElementById('editor');
      const root = document.getElementById('parent');
      if (!(form instanceof HTMLFormElement) || !root)
        throw new Error('Missing synchronous read fixture');
      HTMLFormElement.prototype.reset.call(form);
      return window.nvResetSession.client.get(root, 'query');
    });
    expect(value).toBe('initial');
  });

  it('observes an external form reset through its owned associated model control', async () => {
    await mount({
      elementRoot: true,
      html: '<input id="edit" form="external-form" nv:model="query" value="initial">',
      external: '<form id="external-form"></form>',
    });
    await page.locator('#edit').fill('discarded external form draft');
    await reset('#external-form');
    expect(await get()).toBe('initial');
    expect((await metrics()).requests).toEqual([]);
  });

  it('does not let a subsequent same-turn input edit lose to a pending reset plan', async () => {
    await mount();
    await page.locator('#edit').fill('discarded');
    await page.evaluate(() => {
      const form = document.getElementById('editor');
      const input = document.getElementById('edit');
      if (
        !(form instanceof HTMLFormElement) ||
        !(input instanceof HTMLInputElement)
      )
        throw new Error('Missing subsequent edit fixture');
      HTMLFormElement.prototype.reset.call(form);
      input.value = 'newer user edit';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.clock.runFor(0);
    expect(await get()).toBe('newer user edit');
    expect(await page.locator('#edit').inputValue()).toBe('newer user edit');
  });

  it('cancels reset when a model radio group has no selected default', async () => {
    await mount({
      html: '<form id="editor"><input id="a" type="radio" name="choice" nv:model="choice" value="a"><input id="b" type="radio" name="choice" nv:model="choice" value="b"></form>',
    });
    await page.locator('#b').check();
    await reset();
    expect(await page.locator('#b').isChecked()).toBe(true);
    expect(await get('choice')).toBe('b');
    expect(
      (await metrics()).errors.some((error) => error.code === 'DIRECTIVE'),
    ).toBe(true);
    expect((await metrics()).requests).toEqual([]);
  });

  it('cancels reset rather than choosing between conflicting same-field defaults', async () => {
    await mount({
      html: '<form id="editor"><input id="edit" nv:model="query" value="initial"><input id="alias" nv:model="query" value="different-default"></form>',
    });
    await page.locator('#edit').fill('preserved current draft');
    await reset();
    expect(await page.locator('#edit').inputValue()).toBe(
      'preserved current draft',
    );
    expect(await get()).toBe('preserved current draft');
    expect(
      (await metrics()).errors.some((error) => error.code === 'DIRECTIVE'),
    ).toBe(true);
  });

  it('cancels reset if a native radio group crosses a whole-ignore ownership boundary', async () => {
    await mount({
      html: '<form id="editor"><input id="a" type="radio" name="choice" nv:model="choice" value="a" checked><div nv:ignore=""><input id="b" type="radio" name="choice" value="b"></div></form>',
    });
    await page.locator('#b').check();
    await reset();
    expect(await page.locator('#b').isChecked()).toBe(true);
    expect(
      (await metrics()).errors.some((error) => error.code === 'DIRECTIVE'),
    ).toBe(true);
    expect((await metrics()).requests).toEqual([]);
  });

  it('does not apply a stale reset plan after its model directive changes', async () => {
    await mount();
    await page.locator('#edit').fill('preserved former field');
    await page.evaluate(() =>
      document.addEventListener(
        'reset',
        () =>
          document.getElementById('edit')?.setAttribute('nv:model', 'other'),
        { once: true },
      ),
    );
    await reset();
    expect(await get()).toBe('preserved former field');
    expect(await get('other')).toBe('outside');
    expect((await metrics()).requests).toEqual([]);
  });

  it('captures a completed reset even when the form stops bubbling the reset event', async () => {
    await mount();
    await page.locator('#edit').fill('discarded with stopped propagation');
    await page.locator('#editor').evaluate((element) =>
      element.addEventListener('reset', (event) => event.stopPropagation(), {
        once: true,
      }),
    );
    await reset();
    expect(await get()).toBe('initial');
    expect((await metrics()).errors).toEqual([]);
  });

  it('does not inspect or update unrelated controls outside an element-scoped client', async () => {
    await mount({
      elementRoot: true,
      external:
        '<form id="unowned"><input id="unowned-invalid" nv:model.number="quantity" value="invalid-default"></form>',
    });
    await page.locator('#edit').fill('keep owned draft');
    await reset('#unowned');
    expect(await get()).toBe('keep owned draft');
    expect((await metrics()).errors).toEqual([]);
    expect((await metrics()).requests).toEqual([]);
  });

  it('keeps the most recent default after two native resets in one event turn', async () => {
    await mount();
    await page.locator('#edit').fill('discarded');
    const value = await page.evaluate(() => {
      const form = document.getElementById('editor');
      const root = document.getElementById('parent');
      const input = document.getElementById('edit');
      if (
        !(form instanceof HTMLFormElement) ||
        !(input instanceof HTMLInputElement) ||
        !root
      )
        throw new Error('Missing repeated reset fixture');
      HTMLFormElement.prototype.reset.call(form);
      input.defaultValue = 'newest default';
      HTMLFormElement.prototype.reset.call(form);
      return window.nvResetSession.client.get(root, 'query');
    });
    await page.clock.runFor(0);
    expect(value).toBe('newest default');
    expect(await get()).toBe('newest default');
    expect(await page.locator('#edit').inputValue()).toBe('newest default');
    expect((await metrics()).requests).toEqual([]);
  });

  it('does not apply a pending reset plan to a replacement client registration', async () => {
    await mount();
    await page.locator('#edit').fill('discarded');
    await page.evaluate(() => {
      const form = document.getElementById('editor');
      const root = document.getElementById('parent');
      if (!(form instanceof HTMLFormElement) || !root)
        throw new Error('Missing remount reset fixture');
      HTMLFormElement.prototype.reset.call(form);
      const client = window.nvResetSession.client;
      client.dispose();
      client.mount();
      client.set(root, 'query', 'fresh registration draft');
    });
    await page.clock.runFor(0);
    expect(await get()).toBe('fresh registration draft');
    expect((await metrics()).requests).toEqual([]);
    expect((await metrics()).errors).toEqual([]);
  });

  it('retains an independently scheduled action while replacing its stale model delta', async () => {
    await mount({
      html:
        defaultMarkup +
        '<button id="scheduled" nv:click.debounce.100ms="save">Delayed explicit action</button>',
    });
    await page.locator('#edit').fill('discarded pending delta');
    await page.locator('#scheduled').click();
    await reset();
    await page.clock.runFor(100);
    const requests = (await metrics()).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.updates['query']).not.toBe(
      'discarded pending delta',
    );
    expect(await get()).toBe('initial');
  });

  it('ignores synthetic reset events without canceling the pending native model edit', async () => {
    const html = defaultMarkup.replace(
      'nv:model="query"',
      'nv:model.live.debounce.100ms="query"',
    );
    await mount({ html });
    await page.locator('#edit').fill('keep synthetic-event draft');
    const trusted = await page.locator('#editor').evaluate((element) => {
      const event = new Event('reset', { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.isTrusted;
    });
    expect(trusted).toBe(false);
    await page.clock.runFor(0);
    expect(await page.locator('#edit').inputValue()).toBe(
      'keep synthetic-event draft',
    );
    expect(await get()).toBe('keep synthetic-event draft');
    expect((await metrics()).errors).toEqual([]);
    await page.clock.runFor(100);
    const requests = (await metrics()).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.updates['query']).toBe(
      'keep synthetic-event draft',
    );
    await respond(0, html.replaceAll('initial', 'keep synthetic-event draft'), {
      ...defaultState,
      query: 'keep synthetic-event draft',
    });
    const nativeTrusted = await page.locator('#editor').evaluate((element) => {
      if (!(element instanceof HTMLFormElement))
        throw new Error('Missing native form');
      let trusted = false;
      element.addEventListener(
        'reset',
        (event) => {
          trusted = event.isTrusted;
        },
        { once: true },
      );
      HTMLFormElement.prototype.reset.call(element);
      return trusted;
    });
    expect(nativeTrusted).toBe(true);
  });
});
