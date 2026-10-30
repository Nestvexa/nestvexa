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
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

interface Approval {
  readonly context: import('../packages/client/dist/index.js').LiveConfirmation;
  resolve(value: boolean): void;
  reject(reason: Error): void;
}
interface RequestBody {
  requestId: string;
  revision: number;
  snapshot: string;
  updates: Record<string, unknown>;
}
declare global {
  interface Window {
    nvConfirmFixture: typeof import('../packages/client/dist/index.js');
    nvConfirmSession: {
      client: import('../packages/client/dist/index.js').LiveClient;
      approvals: Approval[];
      requests: { action: string; body: RequestBody }[];
      errors: string[];
      custom: boolean;
    };
  }
}
let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: Server;
let base: string;
let pageErrors: string[];
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response
        .writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; object-src 'none'",
        })
        .end(
          '<!doctype html><html lang="en"><head><title>Confirmation lifecycle fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
    } else if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          "import * as client from '/index.js'; window.nvConfirmFixture=client;",
        );
    } else if (/^\/[a-z][a-z0-9-]*\.js$/.test(path)) {
      void readFile(
        new URL(`../packages/client/dist/${path.slice(1)}`, import.meta.url),
        'utf8',
      ).then(
        (source) =>
          response
            .writeHead(200, { 'content-type': 'text/javascript' })
            .end(source),
        () => response.writeHead(404).end(),
      );
    } else response.writeHead(404).end();
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
  context = await browser.newContext();
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvConfirmFixture'));
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvConfirmSession?.client.dispose());
    await context.close();
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

async function mount(
  options: {
    timeout?: number;
    invalid?: string;
    mode?: 'throw' | 'invalid' | 'dialog';
    count?: number;
    failTransport?: boolean;
  } = {},
): Promise<void> {
  await page.evaluate(({ timeout, invalid, mode, count, failTransport }) => {
    const html = `<form id="confirm-form" nv:submit="save" nv:confirm="Save changes?"><label for="edit">Query</label><input id="edit" nv:model="query" value="initial"><button id="save" type="submit">Save</button></form><button id="remove" type="button" nv:click="remove" nv:confirm="Remove item?">Remove</button><button id="key" type="button" nv:keydown.ctrl.enter="save" nv:confirm="Keyboard action?">Keyboard</button><output id="count" nv:text="count">0</output>`;
    const root = document.createElement('section');
    root.id = 'component';
    for (const [name, value] of Object.entries({
      'data-nv-component': '11111111-1111-4111-8111-111111111111',
      'data-nv-name': 'editor',
      'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'data-nv-revision': '0',
      'data-nv-endpoint': '/live/editor',
      'data-nv-csrf': 'fixture-csrf-012345678901234567890123456789',
      'data-nv-state': JSON.stringify({ query: 'initial', count: 0 }),
    }))
      root.setAttribute(name, value);
    root.innerHTML = html;
    if (invalid !== undefined)
      root.querySelector('#remove')?.setAttribute('nv:confirm', invalid);
    if (count)
      for (let index = 0; index < count; index++) {
        const button = document.createElement('button');
        button.id = `extra-${index}`;
        button.type = 'button';
        button.setAttribute('nv:click', 'save');
        button.setAttribute('nv:confirm', 'Extra?');
        root.append(button);
      }
    document.querySelector('main')?.append(root);
    const approvals: Approval[] = [];
    const requests: { action: string; body: RequestBody }[] = [];
    const errors: string[] = [];
    const clientOptions: import('../packages/client/dist/index.js').LiveClientOptions =
      {
        ...(timeout === undefined ? {} : { confirmationTimeoutMs: timeout }),
        confirm(context) {
          if (!Object.isFrozen(context)) throw new Error('Mutable context');
          if (mode === 'throw')
            throw new Error('private confirmation implementation');
          return new Promise<boolean>((resolve, reject) => {
            approvals.push({ context, resolve, reject });
            if (mode !== 'dialog') return;
            const dialog = document.createElement('dialog');
            const title = document.createElement('h2');
            title.id = 'dialog-title';
            title.textContent = 'Confirm action';
            const message = document.createElement('p');
            message.id = 'dialog-message';
            message.textContent = context.message;
            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', title.id);
            dialog.setAttribute('aria-describedby', message.id);
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.autofocus = true;
            cancel.textContent = 'Cancel';
            const approve = document.createElement('button');
            approve.type = 'button';
            approve.textContent = 'Approve';
            cancel.addEventListener('click', () => dialog.close('cancel'));
            approve.addEventListener('click', () => dialog.close('approve'));
            const aborted = () => {
              if (dialog.open) dialog.close('cancel');
            };
            context.signal.addEventListener('abort', aborted, { once: true });
            dialog.addEventListener(
              'close',
              () => {
                context.signal.removeEventListener('abort', aborted);
                dialog.remove();
                resolve(dialog.returnValue === 'approve');
              },
              { once: true },
            );
            dialog.append(title, message, cancel, approve);
            document.body.append(dialog);
            dialog.showModal();
          });
        },
        onError(error) {
          errors.push(error.message);
        },
        async fetch(url, init) {
          const body = JSON.parse(String(init?.body)) as RequestBody;
          requests.push({ action: String(url).split('/').at(-1) ?? '', body });
          if (failTransport) throw new Error('private transport details');
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: body.requestId,
              component: {
                id: root.getAttribute('data-nv-component'),
                name: 'editor',
                revision: body.revision + 1,
              },
              snapshot: body.snapshot,
              state: {
                query: body.updates['query'] ?? 'initial',
                count: requests.length,
              },
              html,
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      };
    // Deliberately emulate a JavaScript host violating the typed callback contract.
    if (mode === 'invalid') Reflect.set(clientOptions, 'confirm', () => 'yes');
    const client = window.nvConfirmFixture.createLiveClient(clientOptions);
    window.nvConfirmSession = {
      client,
      approvals,
      requests,
      errors,
      custom: true,
    };
    client.mount();
  }, options);
}
async function state() {
  return page.evaluate(() => ({
    approvals: window.nvConfirmSession.approvals.length,
    aborted: window.nvConfirmSession.approvals.map(
      ({ context }) => context.signal.aborted,
    ),
    requests: window.nvConfirmSession.requests,
    errors: window.nvConfirmSession.errors,
  }));
}
async function answer(index: number, approved: boolean): Promise<void> {
  await page.evaluate(
    ({ index, approved }) =>
      window.nvConfirmSession.approvals[index]?.resolve(approved),
    { index, approved },
  );
  await page.clock.runFor(0);
}

describe('confirmation lifecycle in actual Chromium with controlled dialog/transport', () => {
  it('consumes once on an approval attempt and never falls through to native link navigation', async () => {
    await mount();
    await page.locator('#remove').evaluate((button) => {
      const link = document.createElement('a');
      link.id = 'remove';
      link.href = '/unwanted-navigation';
      link.textContent = 'Confirmed link';
      link.setAttribute('nv:click.once', 'remove');
      link.setAttribute('nv:confirm', 'Continue?');
      button.replaceWith(link);
    });
    await page.locator('#remove').click();
    await answer(0, false);
    await page.locator('#remove').click();
    expect(page.url()).toBe(base + '/');
    expect(await state()).toMatchObject({ approvals: 1, requests: [] });
  });
  it('rejects a late answer across explicit disposal and remount', async () => {
    await mount();
    await page.locator('#remove').click();
    await page.evaluate(() => {
      window.nvConfirmSession.client.dispose();
      window.nvConfirmSession.client.mount();
    });
    await answer(0, true);
    expect((await state()).requests).toEqual([]);
    await page.locator('#remove').click();
    await answer(1, true);
    expect((await state()).requests).toHaveLength(1);
  });
  it('aborts pending approval when other work on its component has an uncertain failure', async () => {
    await mount({ failTransport: true });
    await page.locator('#remove').click();
    await page.evaluate(async () => {
      const root = document.getElementById('component');
      if (!root) throw new Error('Missing owner');
      await window.nvConfirmSession.client
        .call(root, 'save')
        .catch(() => undefined);
    });
    expect((await state()).aborted).toEqual([true]);
    await answer(0, true);
    expect((await state()).requests).toHaveLength(1);
  });
  it('uses a 30 second default approval deadline', async () => {
    await mount();
    await page.locator('#remove').click();
    await page.clock.runFor(29999);
    expect((await state()).aborted).toEqual([false]);
    await page.clock.runFor(1);
    expect((await state()).aborted).toEqual([true]);
    expect((await state()).requests).toEqual([]);
  });
  it('rejects a dynamically added unsupported modifier before prompting or sending', async () => {
    await mount();
    await page.locator('#remove').evaluate((button) => {
      button.setAttribute('nv:confirm.prompt', 'Unsupported');
      if (!(button instanceof HTMLButtonElement))
        throw new Error('Missing confirmation button');
      button.click();
    });
    expect(await state()).toMatchObject({
      approvals: 0,
      requests: [],
      errors: ['Use one unmodified nv:confirm declaration'],
    });
  });
  it.each([0, -1, 0.5, NaN, Infinity, 300001])(
    'rejects invalid approval deadline %s before mounting',
    async (timeout) => {
      const message = await page.evaluate((timeout) => {
        try {
          window.nvConfirmFixture.createLiveClient({
            confirmationTimeoutMs: timeout,
          });
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
      }, timeout);
      expect(message).toContain('Confirmation timeout');
    },
  );
  it('supports an accessible asynchronous dialog with literal text, keyboard cancellation and focus return', async () => {
    await mount({ mode: 'dialog', invalid: '<img src=x onerror=alert(1)>' });
    await page.clock.resume();
    await page.locator('#remove').focus();
    await page.locator('#remove').press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Confirm action' });
    await dialog.waitFor({ state: 'visible' });
    expect(await dialog.locator('p').textContent()).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(await dialog.locator('img').count()).toBe(0);
    expect(
      await page
        .getByRole('button', { name: 'Cancel', exact: true })
        .evaluate((button) => document.activeElement === button),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(
      await page
        .locator('#remove')
        .evaluate((button) => document.activeElement === button),
    ).toBe(true);
    expect((await state()).requests).toHaveLength(0);
    await page.locator('#remove').press('Enter');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(
      () => window.nvConfirmSession.requests.length === 1,
    );
    expect((await state()).errors).toEqual([]);
  });
  it('sends nothing before approval, deduplicates pending submits and reads current drafts at dispatch', async () => {
    await mount();
    await page.locator('#edit').fill('first');
    await page.locator('#save').click();
    await page.locator('#save').click();
    expect(await state()).toMatchObject({
      approvals: 1,
      requests: [],
      errors: [],
    });
    expect(await page.locator('#component').getAttribute('aria-busy')).toBe(
      'false',
    );
    await page.locator('#edit').fill('newer');
    await answer(0, true);
    expect((await state()).requests.map(({ body }) => body.updates)).toEqual([
      { query: 'newer' },
    ]);
    expect(
      await page.locator('#component').getAttribute('data-nv-revision'),
    ).toBe('1');
  });

  it('cancels without dirty loss and permits a later explicit attempt', async () => {
    await mount();
    await page.locator('#edit').fill('draft');
    await page.locator('#save').click();
    await answer(0, false);
    expect(await state()).toMatchObject({ requests: [], aborted: [true] });
    expect(await page.locator('#edit').inputValue()).toBe('draft');
    await page.locator('#save').click();
    await answer(1, true);
    expect((await state()).requests).toHaveLength(1);
  });

  it.each([
    'remove',
    'dispose',
    'ignore',
    'reparent',
    'reconfigure',
    'disabled',
    'inert',
    'marker',
  ] as const)('aborts and ignores late approval after %s', async (mode) => {
    await mount();
    await page.locator('#remove').click();
    await page.evaluate((mode) => {
      const button = document.getElementById('remove');
      const root = document.getElementById('component');
      if (!button || !root) throw new Error('Missing fixture');
      if (mode === 'remove') button.remove();
      else if (mode === 'dispose') window.nvConfirmSession.client.dispose();
      else if (mode === 'ignore') button.setAttribute('nv:ignore', '');
      else if (mode === 'reparent')
        document.querySelector('main')?.append(button);
      else if (mode === 'reconfigure')
        button.setAttribute('nv:confirm', 'Different intent?');
      else if (mode === 'disabled') button.setAttribute('disabled', '');
      else if (mode === 'inert') root.setAttribute('inert', '');
      else root.setAttribute('data-nv-revision', '99');
    }, mode);
    expect((await state()).aborted).toEqual([true]);
    await answer(0, true);
    expect((await state()).requests).toEqual([]);
  });

  it('bounds uncooperative dialogs by deadline and never accepts a late answer', async () => {
    await mount({ timeout: 100 });
    await page.locator('#remove').click();
    await page.clock.runFor(100);
    expect((await state()).aborted).toEqual([true]);
    await answer(0, true);
    expect((await state()).requests).toEqual([]);
    await page.locator('#remove').click();
    expect((await state()).approvals).toBe(2);
  });

  it.each(['throw', 'invalid'] as const)(
    'fails closed for a %s custom provider without exposing its text',
    async (mode) => {
      await mount({ mode });
      await page.locator('#remove').click();
      await page.clock.runFor(0);
      expect(await state()).toMatchObject({
        requests: [],
        errors: ['Live confirmation failed'],
      });
    },
  );

  it('handles asynchronous rejection without an unhandled promise or request', async () => {
    await mount();
    await page.locator('#remove').click();
    await page.evaluate(() =>
      window.nvConfirmSession.approvals[0]?.reject(
        new Error('private cookie debug'),
      ),
    );
    await page.clock.runFor(0);
    expect(await state()).toMatchObject({
      requests: [],
      errors: ['Live confirmation failed'],
      aborted: [true],
    });
    await page.locator('#remove').click();
    await answer(1, true);
    expect((await state()).requests).toHaveLength(1);
  });

  it('filters keyboard events before preventing defaults or asking for approval', async () => {
    await mount();
    const prevented = await page.locator('#key').evaluate((button) => {
      const wrong = new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(wrong);
      const right = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(right);
      return [wrong.defaultPrevented, right.defaultPrevented];
    });
    expect(prevented).toEqual([false, true]);
    expect((await state()).approvals).toBe(1);
    await answer(0, true);
    expect((await state()).requests).toHaveLength(1);
  });

  it('caps pending approvals and releases every slot on disposal', async () => {
    await mount({ count: 17 });
    await page.evaluate(() => {
      for (let index = 0; index < 17; index++)
        document.getElementById(`extra-${index}`)?.click();
    });
    expect(await state()).toMatchObject({
      approvals: 16,
      requests: [],
      errors: ['Confirmation capacity reached'],
    });
    await page.evaluate(() => window.nvConfirmSession.client.dispose());
    expect((await state()).aborted.every(Boolean)).toBe(true);
  });

  it.each(['', 'x'.repeat(1025)])(
    'rejects invalid confirmation markup before attaching actions',
    async (invalid) => {
      await mount({ invalid });
      await page.locator('#remove').click();
      expect(await state()).toMatchObject({ approvals: 0, requests: [] });
      expect((await state()).errors).toHaveLength(1);
    },
  );
});
