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
import { createFocusController } from '../packages/client/dist/focus.js';

declare global {
  interface Window {
    nvFocusFixture: typeof import('../packages/client/dist/focus.js');
  }
}

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
let errors: string[];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Focus ownership fixture</title><script type="module" src="/fixture.js"></script></head><body><main id="fixture"><section id="root"><input id="edit"></section><button id="outside">Outside</button></main></body></html>',
        );
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as focus from '/focus.js'; window.nvFocusFixture = focus;",
        );
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
    throw new Error('Missing focus fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  errors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvFocusFixture'));
});
afterEach(async () => {
  if (page) await page.close();
  expect(errors).toEqual([]);
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

it('creates and disposes a controller in Node without DOM globals', () => {
  const controller = createFocusController();
  controller.prune();
  controller.dispose();
  controller.dispose();
});

describe('temporary browser focus ownership', () => {
  it.each(['blur', 'release', 'dispose', 'prune'] as const)(
    'releases temporary tabindex and listener through %s',
    async (mode) => {
      const result = await page.evaluate((mode) => {
        const root = document.getElementById('root');
        const outside = document.getElementById('outside');
        if (!(root instanceof HTMLElement) || !(outside instanceof HTMLElement))
          throw new Error('Missing fixture');
        const controller = window.nvFocusFixture.createFocusController();
        controller.focus(root, root);
        const initial = {
          focused: document.activeElement === root,
          tabindex: root.getAttribute('tabindex'),
        };
        if (mode === 'blur') outside.focus();
        else if (mode === 'release') controller.release(root);
        else if (mode === 'dispose') controller.dispose();
        else {
          root.remove();
          controller.prune();
        }
        const released = root.getAttribute('tabindex');
        root.setAttribute('tabindex', '0');
        outside.focus();
        return { initial, released, host: root.getAttribute('tabindex') };
      }, mode);
      expect(result).toEqual({
        initial: { focused: true, tabindex: '-1' },
        released: null,
        host: '0',
      });
    },
  );

  it.each(['0', '-1'])(
    'keeps pre-existing host tabindex %s on disposal',
    async (value) => {
      const result = await page.evaluate((value) => {
        const root = document.getElementById('root');
        if (!(root instanceof HTMLElement)) throw new Error('Missing root');
        root.setAttribute('tabindex', value);
        const controller = window.nvFocusFixture.createFocusController();
        controller.focus(root, root);
        controller.dispose();
        return {
          focused: document.activeElement === root,
          value: root.getAttribute('tabindex'),
        };
      }, value);
      expect(result).toEqual({ focused: true, value });
    },
  );

  it('preserves a changed host tabindex on cleanup and forgets its old blur listener', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      const outside = document.getElementById('outside');
      if (!(root instanceof HTMLElement) || !(outside instanceof HTMLElement))
        throw new Error('Missing fixture');
      const controller = window.nvFocusFixture.createFocusController();
      controller.focus(root, root);
      root.setAttribute('tabindex', '0');
      controller.dispose();
      outside.focus();
      return root.getAttribute('tabindex');
    });
    expect(result).toBe('0');
  });

  it('coordinates shared parent leases between separate controllers', async () => {
    const result = await page.evaluate(() => {
      const parent = document.getElementById('fixture');
      const first = document.getElementById('root');
      if (!(parent instanceof HTMLElement) || !(first instanceof HTMLElement))
        throw new Error('Missing fixture');
      const second = document.createElement('section');
      parent.append(second);
      const one = window.nvFocusFixture.createFocusController();
      const two = window.nvFocusFixture.createFocusController();
      one.focus(parent, first);
      two.focus(parent, second);
      one.dispose();
      const retained = parent.getAttribute('tabindex');
      two.release(second);
      const released = parent.getAttribute('tabindex');
      return { retained, released };
    });
    expect(result).toEqual({ retained: '-1', released: null });
  });

  it('retains another owner lease within the same controller', async () => {
    const result = await page.evaluate(() => {
      const parent = document.getElementById('fixture');
      const first = document.getElementById('root');
      if (!(parent instanceof HTMLElement) || !(first instanceof HTMLElement))
        throw new Error('Missing fixture');
      const second = document.createElement('section');
      parent.append(second);
      const controller = window.nvFocusFixture.createFocusController();
      controller.focus(parent, first);
      controller.focus(parent, second);
      controller.release(first);
      const retained = parent.getAttribute('tabindex');
      controller.release(second);
      return { retained, released: parent.getAttribute('tabindex') };
    });
    expect(result).toEqual({ retained: '-1', released: null });
  });

  it('clears every shared lease after native blur without retaining stale cleanup', async () => {
    const result = await page.evaluate(() => {
      const parent = document.getElementById('fixture');
      const root = document.getElementById('root');
      const outside = document.getElementById('outside');
      if (
        !(parent instanceof HTMLElement) ||
        !(root instanceof HTMLElement) ||
        !(outside instanceof HTMLElement)
      )
        throw new Error('Missing fixture');
      const one = window.nvFocusFixture.createFocusController();
      const two = window.nvFocusFixture.createFocusController();
      one.focus(parent, root);
      two.focus(parent, root);
      outside.focus();
      const released = parent.getAttribute('tabindex');
      parent.setAttribute('tabindex', '0');
      one.dispose();
      two.dispose();
      return { released, host: parent.getAttribute('tabindex') };
    });
    expect(result).toEqual({ released: null, host: '0' });
  });

  it('prunes an owner moved outside its original fallback ancestor', async () => {
    const result = await page.evaluate(() => {
      const parent = document.getElementById('fixture');
      const root = document.getElementById('root');
      if (!(parent instanceof HTMLElement) || !(root instanceof HTMLElement))
        throw new Error('Missing fixture');
      const controller = window.nvFocusFixture.createFocusController();
      controller.focus(parent, root);
      document.body.append(root);
      controller.prune();
      return parent.getAttribute('tabindex');
    });
    expect(result).toBeNull();
  });

  it('releases a failed native focus attempt immediately', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      const controller = window.nvFocusFixture.createFocusController();
      root.focus = () => {};
      controller.focus(root, root);
      return root.getAttribute('tabindex');
    });
    expect(result).toBeNull();
  });

  it('cleans up when a trusted focus implementation throws', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      if (!(root instanceof HTMLElement)) throw new Error('Missing root');
      const controller = window.nvFocusFixture.createFocusController();
      root.focus = () => {
        throw new Error('Host focus failure');
      };
      let message = '';
      try {
        controller.focus(root, root);
      } catch (error) {
        message = error instanceof Error ? error.message : 'unknown';
      }
      return { message, tabindex: root.getAttribute('tabindex') };
    });
    expect(result).toEqual({ message: 'Host focus failure', tabindex: null });
  });

  it('observes synchronous focus redirection and removes temporary ownership', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      const outside = document.getElementById('outside');
      if (!(root instanceof HTMLElement) || !(outside instanceof HTMLElement))
        throw new Error('Missing fixture');
      root.addEventListener('focus', () => outside.focus());
      const controller = window.nvFocusFixture.createFocusController();
      controller.focus(root, root);
      return {
        redirected: document.activeElement === outside,
        tabindex: root.getAttribute('tabindex'),
      };
    });
    expect(result).toEqual({ redirected: true, tabindex: null });
  });

  it('can be disposed reentrantly by the focus handler and ignores later focus calls', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      const outside = document.getElementById('outside');
      if (!(root instanceof HTMLElement) || !(outside instanceof HTMLElement))
        throw new Error('Missing fixture');
      const controller = window.nvFocusFixture.createFocusController();
      root.addEventListener('focus', () => controller.dispose());
      controller.focus(root, root);
      outside.focus();
      controller.focus(root, root);
      return {
        outside: document.activeElement === outside,
        tabindex: root.getAttribute('tabindex'),
      };
    });
    expect(result).toEqual({ outside: true, tabindex: null });
  });

  it.each(['hidden', 'inert', 'display', 'visibility', 'disabled'] as const)(
    'does not borrow tabindex for unavailable %s targets',
    async (kind) => {
      const result = await page.evaluate((kind) => {
        const prior = document.getElementById('root');
        if (!(prior instanceof HTMLElement)) throw new Error('Missing root');
        let root: HTMLElement = prior;
        if (kind === 'disabled') {
          const button = document.createElement('button');
          button.disabled = true;
          prior.replaceWith(button);
          root = button;
        } else if (kind === 'hidden' || kind === 'inert')
          root.setAttribute(kind, '');
        else if (kind === 'display') root.style.display = 'none';
        else root.style.visibility = 'hidden';
        const controller = window.nvFocusFixture.createFocusController();
        controller.focus(root, root);
        return {
          available: window.nvFocusFixture.availableForFocus(root),
          tabindex: root.getAttribute('tabindex'),
        };
      }, kind);
      expect(result).toEqual({ available: false, tabindex: null });
    },
  );

  it('moves focus before hiding a child and releases parent fallback when hiding the root', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      const edit = document.getElementById('edit');
      const parent = document.getElementById('fixture');
      if (
        !(root instanceof HTMLElement) ||
        !(edit instanceof HTMLElement) ||
        !(parent instanceof HTMLElement)
      )
        throw new Error('Missing fixture');
      const controller = window.nvFocusFixture.createFocusController();
      edit.focus();
      controller.beforeHiding(root, edit);
      const childFallback = document.activeElement === root;
      controller.beforeHiding(root, root);
      const rootFallback = document.activeElement === parent;
      const childTemporary = root.getAttribute('tabindex');
      controller.release(root);
      return {
        childFallback,
        rootFallback,
        childTemporary,
        parentTemporary: parent.getAttribute('tabindex'),
      };
    });
    expect(result).toEqual({
      childFallback: true,
      rootFallback: true,
      childTemporary: null,
      parentTemporary: null,
    });
  });

  it('does not move focus when the hidden subtree does not contain it', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('root');
      const edit = document.getElementById('edit');
      const outside = document.getElementById('outside');
      if (
        !(root instanceof HTMLElement) ||
        !(edit instanceof HTMLElement) ||
        !(outside instanceof HTMLElement)
      )
        throw new Error('Missing fixture');
      outside.focus();
      const controller = window.nvFocusFixture.createFocusController();
      controller.beforeHiding(root, edit);
      return {
        outside: document.activeElement === outside,
        tabindex: root.getAttribute('tabindex'),
      };
    });
    expect(result).toEqual({ outside: true, tabindex: null });
  });
});
