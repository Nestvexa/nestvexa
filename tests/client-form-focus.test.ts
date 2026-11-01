import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';

declare global {
  interface Window {
    nvFormFocus: typeof import('../packages/client/dist/focus.js');
  }
}

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
let errors: string[];

const fixture = `<!doctype html><html lang="en"><head><title>Invalid field focus fixture</title><script type="module" src="/fixture.js"></script></head><body><main>
<section id="root" data-nv-component="c1">
  <form id="form">
    <input id="valid" aria-invalid="false">
    <input id="hidden" aria-invalid="true" hidden>
    <input id="disabled" aria-invalid="true" disabled>
    <div data-nv-component="child"><input id="child" aria-invalid="true"></div>
    <div data-nv-ignore><input id="ignored" aria-invalid="true"></div>
    <input id="first" aria-invalid="true">
    <input id="second" aria-invalid="true">
    <button id="submit">Save</button>
  </form>
</section>
<button id="elsewhere">Elsewhere</button>
</main></body></html>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(fixture);
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end("import * as focus from '/focus.js'; window.nvFormFocus = focus;");
      return;
    }
    if (path !== '/focus.js') {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL('../packages/client/dist/focus.js', import.meta.url),
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
  errors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvFormFocus'));
});
afterEach(async () => {
  await page.close();
  expect(errors).toEqual([]);
});
afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function run(previousId: string | null): Promise<{
  moved: boolean;
  active: string;
}> {
  return page.evaluate((id) => {
    const root = document.getElementById('root');
    const form = document.getElementById('form');
    if (!root || !form) throw new Error('fixture');
    const owns = (node: Element) =>
      node.closest('[data-nv-component]') === root &&
      !node.closest('[data-nv-ignore]');
    const moved = window.nvFormFocus.focusFirstInvalid(
      form,
      id === null ? null : document.getElementById(id),
      root,
      owns,
    );
    return { moved, active: document.activeElement?.id ?? '' };
  }, previousId);
}

it('focuses the first available owned invalid control', async () => {
  await page.focus('#submit');
  expect(await run('submit')).toEqual({ moved: true, active: 'first' });
});

it('treats focus loss (body) and root fallback focus as unmoved', async () => {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  expect(await run('submit')).toEqual({ moved: true, active: 'first' });
  await page.evaluate(() => {
    const root = document.getElementById('root');
    root?.setAttribute('tabindex', '-1');
    root?.focus();
  });
  expect(await run('submit')).toEqual({ moved: true, active: 'first' });
});

it('respects a user who moved focus during the request', async () => {
  await page.focus('#elsewhere');
  expect(await run('submit')).toEqual({ moved: false, active: 'elsewhere' });
});

it('does nothing when no available invalid control exists', async () => {
  await page.evaluate(() => {
    for (const id of ['first', 'second'])
      document.getElementById(id)?.setAttribute('aria-invalid', 'false');
  });
  await page.focus('#submit');
  expect(await run('submit')).toEqual({ moved: false, active: 'submit' });
  await page.evaluate(() => document.getElementById('form')?.remove());
});
