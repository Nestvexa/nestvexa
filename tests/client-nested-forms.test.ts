/**
 * Real-Chromium regression: `nv:submit` in a nested child component moves
 * focus to the first invalid field of the submitted form after the child's
 * response, exactly like a top-level component (showcase finding).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { readFile } from 'node:fs/promises';

declare global {
  interface Window {
    nvErrors: string[];
  }
}

const bundleUrl = new URL('../packages/client/dist/index.js', import.meta.url);
const parentId = '33333333-3333-4333-8333-333333333333';
const childId = '44444444-4444-4444-8444-444444444444';
const token = 'C'.repeat(43);
const csrf = 'nested-forms-csrf-0123456789012345678901234';
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
interface Form {
  name: string;
  email: string;
  errors: boolean;
}
function form(state: Form): string {
  const invalid = state.errors ? ' aria-invalid="true"' : '';
  return (
    '<form id="signup" nv:submit="save">' +
    `<label for="name">Name</label><input id="name" nv:model="name" value="${escape(state.name)}">` +
    `<label for="email">Email</label><input id="email" nv:model="email"${invalid} value="${escape(state.email)}">` +
    (state.errors ? '<p id="email-error">Enter an email address</p>' : '') +
    '<button id="submit" type="submit" nv:loading.attr="disabled">Save</button>' +
    '<button id="ping" type="button" nv:click="ping">Ping</button>' +
    '</form>'
  );
}
function root(
  id: string,
  name: string,
  state: object,
  inner: string,
  extra = '',
): string {
  return `<div data-nv-component="${id}" data-nv-name="${name}" data-nv-snapshot="${token}" data-nv-state="${escape(JSON.stringify(state))}" data-nv-revision="0" data-nv-endpoint="/live/${name}" data-nv-csrf="${csrf}"${extra}>${inner}</div>`;
}
const initial: Form = { name: '', email: '', errors: false };
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nested forms</title><script type="module" src="/boot.js"></script></head><body><main>${root(
  parentId,
  'signup-page',
  { title: 'Join' },
  `<h1>Join</h1><button id="hello" type="button" nv:click="hello">Hello</button>${root(childId, 'signup-form', { name: '', email: '' }, form(initial), ' data-nv-key="nv-child:form:main"')}`,
  ` data-nv-listeners="${escape(JSON.stringify({ 'signup.checked': ['checked'] }))}"`,
)}</main></body></html>`;
const boot = `import { createLiveClient } from '/index.js';
window.nvErrors = [];
window.nvClient = createLiveClient({ onError(error) { window.nvErrors.push(error.code ?? error.name); } });
window.nvClient.mount();`;
/** Every Live POST the fake server received: path and parsed envelope. */
const posted: { path: string; updates: unknown; input: unknown }[] = [];

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let browser: Browser;
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(page);
      return;
    }
    if (path === '/boot.js' || path === '/index.js') {
      const send = (source: string) =>
        response
          .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          .end(source);
      if (path === '/boot.js') send(boot);
      else
        void readFile(bundleUrl, 'utf8').then(send, () =>
          response.writeHead(404).end(),
        );
      return;
    }
    if (
      request.method === 'POST' &&
      (path === '/live/signup-form/ping' || path === '/live/signup-page/hello')
    ) {
      void body(request).then((text) => {
        const envelope = JSON.parse(text) as {
          requestId: string;
          revision: number;
          updates: Partial<Form>;
          input: unknown;
        };
        posted.push({ path, updates: envelope.updates, input: envelope.input });
        const child = path.includes('signup-form');
        const state = child
          ? {
              name: envelope.updates.name ?? '',
              email: envelope.updates.email ?? '',
            }
          : { title: 'Join' };
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: envelope.requestId,
            component: {
              id: child ? childId : parentId,
              name: child ? 'signup-form' : 'signup-page',
              revision: envelope.revision + 1,
            },
            snapshot: token,
            state,
            // @Title: only a top-level component may change document.title.
            title: child ? 'Child must not win' : 'Join · updated',
            html: child
              ? form({
                  name: state.name ?? '',
                  email: state.email ?? '',
                  errors: false,
                })
              : `<h1>Join</h1><button id="hello" type="button" nv:click="hello">Hello</button><div data-nv-component="${childId}" data-nv-key="nv-child:form:main" data-nv-stub=""></div>`,
          }),
        );
      });
      return;
    }
    if (request.method === 'POST' && path === '/live/signup-page/checked') {
      // The parent reacts to the child's event and refreshes the child root
      // (a reactive prop changed), replacing the focused child subtree.
      void body(request).then((text) => {
        const envelope = JSON.parse(text) as {
          requestId: string;
          revision: number;
        };
        const child = root(
          childId,
          'signup-form',
          { name: 'Ada', email: '' },
          form({ name: 'Ada', email: '', errors: true }),
          ' data-nv-key="nv-child:form:main" data-nv-refresh=""',
        ).replace('data-nv-revision="0"', 'data-nv-revision="2"');
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: envelope.requestId,
            component: {
              id: parentId,
              name: 'signup-page',
              revision: envelope.revision + 1,
            },
            snapshot: token,
            state: { title: 'Join' },
            html: `<h1>Join</h1>${child}`,
          }),
        );
      });
      return;
    }
    if (request.method === 'POST' && path === '/live/signup-form/save') {
      void body(request).then((text) => {
        const envelope = JSON.parse(text) as {
          requestId: string;
          revision: number;
          updates: Partial<Form>;
        };
        const state = {
          name: envelope.updates.name ?? '',
          email: envelope.updates.email ?? '',
        };
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: envelope.requestId,
            component: {
              id: childId,
              name: 'signup-form',
              revision: envelope.revision + 1,
            },
            snapshot: token,
            state,
            html: form({ ...state, errors: !state.email.includes('@') }),
            ...(state.name === 'Grace'
              ? { events: [{ name: 'signup.checked', payload: null }] }
              : {}),
          }),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function open(): Promise<Page> {
  const target = await browser.newPage();
  await target.goto(`${base}/`);
  await target.waitForFunction(() =>
    document
      .querySelector('[data-nv-name="signup-form"]')
      ?.hasAttribute('aria-busy'),
  );
  return target;
}
const active = (target: Page) =>
  target.evaluate(() => document.activeElement?.id ?? '');

describe('nested child forms', () => {
  it('focuses the first invalid field after a submit button press', async () => {
    const target = await open();
    await target.fill('#name', 'Ada');
    await target.click('#submit');
    await expect.poll(() => active(target)).toBe('email');
    expect(await target.getAttribute('#email', 'aria-invalid')).toBe('true');
    expect(await target.evaluate(() => window.nvErrors)).toEqual([]);
    await target.close();
  });

  it('focuses the first invalid field after implicit Enter submission', async () => {
    const target = await open();
    await target.fill('#name', 'Ada');
    await target.press('#name', 'Enter');
    await expect.poll(() => active(target)).toBe('email');
    await target.close();
  });

  it('keeps focus on the invalid field when the parent then refreshes the child root', async () => {
    const target = await open();
    await target.fill('#name', 'Grace');
    await target.click('#submit');
    // The parent's response replaced the child root (revision 2 markup).
    await expect
      .poll(() =>
        target.getAttribute('[data-nv-name="signup-page"]', 'data-nv-revision'),
      )
      .toBe('1');
    await expect.poll(() => active(target)).toBe('email');
    expect(await target.evaluate(() => window.nvErrors)).toEqual([]);
    await target.close();
  });

  it('owns nested directives by the nearest root and attaches listeners once (PROT-006)', async () => {
    const target = await open();
    posted.length = 0;
    // A second mount() of the same client must not attach listeners twice.
    await target.evaluate(() =>
      (window as unknown as { nvClient: { mount(): void } }).nvClient.mount(),
    );
    await target.click('#ping');
    await expect.poll(() => posted.length).toBe(1);
    await expect
      .poll(() =>
        target.getAttribute('[data-nv-name="signup-form"]', 'data-nv-revision'),
      )
      .toBe('1');
    expect(await target.title()).toBe('Nested forms');
    await target.click('#hello');
    await expect.poll(() => posted.length).toBe(2);
    await target.waitForTimeout(200);
    expect(posted.map((entry) => entry.path)).toEqual([
      '/live/signup-form/ping',
      '/live/signup-page/hello',
    ]);
    // The parent response kept the child (stub): the child still works.
    await target.click('#ping');
    await expect.poll(() => posted.length).toBe(3);
    expect(posted[2]?.path).toBe('/live/signup-form/ping');
    // The parent's title applied; the nested child's title was ignored.
    expect(await target.title()).toBe('Join · updated');
    expect(await target.evaluate(() => window.nvErrors)).toEqual([]);
    await target.close();
  });

  it('bundles only changed fields with the action ID in one request (PROT-007)', async () => {
    const target = await open();
    posted.length = 0;
    await target.fill('#name', 'Ada');
    await target.fill('#email', 'ada@example.com');
    // Deferred models send nothing until an action runs.
    await target.waitForTimeout(150);
    expect(posted).toEqual([]);
    await target.click('#ping');
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toEqual({
      path: '/live/signup-form/ping',
      updates: { name: 'Ada', email: 'ada@example.com' },
      input: null,
    });
    // Acknowledged fields are not resent; an unchanged field never is.
    await target.fill('#name', 'Grace');
    await target.click('#ping');
    await expect.poll(() => posted.length).toBe(2);
    expect(posted[1]?.updates).toEqual({ name: 'Grace' });
    await target.close();
  });

  it('leaves focus alone when the submission is valid', async () => {
    const target = await open();
    await target.fill('#name', 'Ada');
    await target.fill('#email', 'ada@example.com');
    await target.click('#submit');
    await expect
      .poll(() =>
        target.getAttribute('[data-nv-name="signup-form"]', 'data-nv-revision'),
      )
      .toBe('1');
    expect(await active(target)).not.toBe('email');
    await target.close();
  });
});
