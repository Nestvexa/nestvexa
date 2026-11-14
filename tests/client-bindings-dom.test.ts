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

declare global {
  interface Window {
    nvBindingFixture: typeof import('../packages/client/dist/bindings.js');
    nvLoadingFixture: typeof import('../packages/client/dist/loading.js');
    nvPresentationFixture: typeof import('../packages/client/dist/presentation.js');
  }
}

let browser: Browser;
let server: Server;
let page: Page;
let base: string;

beforeAll(async () => {
  const assets = new Map([
    ['/focus.js', new URL('../packages/client/dist/focus.js', import.meta.url)],
    [
      '/bindings.js',
      new URL('../packages/client/dist/bindings.js', import.meta.url),
    ],
    [
      '/grammar.js',
      new URL('../packages/client/dist/grammar.js', import.meta.url),
    ],
    [
      '/loading.js',
      new URL('../packages/client/dist/loading.js', import.meta.url),
    ],
    [
      '/presentation.js',
      new URL('../packages/client/dist/presentation.js', import.meta.url),
    ],
  ]);
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>Live binding fixture</title><script type="module" src="/fixture.js"></script></head><body><main id="fixture"></main></body></html>',
      );
      return;
    }
    if (pathname === '/fixture.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
      });
      response.end(
        "import * as bindings from '/bindings.js'; import * as loading from '/loading.js'; import * as presentation from '/presentation.js'; window.nvLoadingFixture = loading; window.nvPresentationFixture = presentation; window.nvBindingFixture = bindings;",
      );
      return;
    }
    const file = assets.get(pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    void readFile(file, 'utf8').then(
      (source) => {
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
        });
        response.end(source);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing binding fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvBindingFixture'));
});

afterEach(async () => {
  if (page) await page.close();
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe('real-browser data binding ownership and atomic validation', () => {
  it('writes safe text and browser attributes, clears boolean attributes and removes cloak after success', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span id="text" nv:text="message" nv:cloak="">before</span><button id="disabled" disabled nv:bind="disabled:pending">Action</button><input id="readonly" readonly nv:bind="readonly:pending"><span id="aria" nv:bind="aria-expanded:expanded"></span><a id="link" nv:bind="href:destination">Link</a>';
      document.body.append(root);
      const state: Record<string, unknown> = {
        message: '<img src=x onerror=alert(1)>',
        pending: false,
        expanded: true,
        destination: '/safe',
      };
      window.nvBindingFixture.applyBindings(
        root,
        (name) => state[name],
        () => false,
      );
      const link = root.querySelector('#link');
      const text = root.querySelector('#text');
      const initial = {
        text: text?.textContent,
        images: root.querySelectorAll('img').length,
        cloak: text?.hasAttribute('nv:cloak'),
        disabled: root.querySelector('#disabled')?.hasAttribute('disabled'),
        readonly: root.querySelector('#readonly')?.hasAttribute('readonly'),
        aria: root.querySelector('#aria')?.getAttribute('aria-expanded'),
        href: link?.getAttribute('href'),
      };
      state['pending'] = true;
      state['expanded'] = false;
      state['destination'] = null;
      window.nvBindingFixture.applyBindings(
        root,
        (name) => state[name],
        () => false,
      );
      return {
        initial,
        final: {
          disabled: root.querySelector('#disabled')?.hasAttribute('disabled'),
          readonly: root.querySelector('#readonly')?.hasAttribute('readonly'),
          aria: root.querySelector('#aria')?.getAttribute('aria-expanded'),
          href: link?.getAttribute('href'),
        },
      };
    });
    expect(result.initial).toEqual({
      text: '<img src=x onerror=alert(1)>',
      images: 0,
      cloak: false,
      disabled: false,
      readonly: false,
      aria: 'true',
      href: '/safe',
    });
    expect(result.final).toEqual({
      disabled: true,
      readonly: true,
      aria: 'false',
      href: null,
    });
  });

  it('validates a late unsafe URL before changing earlier text or removing cloak', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span nv:text="message" nv:cloak="">unchanged</span><a href="/original" nv:bind="href:destination">Link</a>';
      document.body.append(root);
      const before = root.innerHTML;
      let message = '';
      try {
        window.nvBindingFixture.applyBindings(
          root,
          (name) =>
            name === 'message' ? 'must not appear' : 'javascript:alert(1)',
          () => false,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : 'unknown';
      }
      return { before, after: root.innerHTML, message };
    });
    expect(result.after).toBe(result.before);
    expect(result.message).toContain('HTTP(S)');
  });

  it('ignores all directives and refs in nested Live, ignored and island subtrees', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span id="owned" nv:text="message" nv:ref="owned">before</span><div data-nv-component="child"><span id="nested" nv:text="malformed()" nv:ref="owned">nested</span></div><div nv:ignore=""><span id="ignored" nv:text="malformed()" nv:ref="owned">ignored</span></div><div data-nv-island="widget"><span id="island" nv:text="malformed()" nv:ref="owned">island</span></div>';
      document.body.append(root);
      const read: string[] = [];
      window.nvBindingFixture.applyBindings(
        root,
        (name) => {
          read.push(name);
          return 'updated';
        },
        () => false,
      );
      const refs = window.nvBindingFixture.queryRefs(root);
      return {
        read,
        ids: [...refs].map(([name, element]) => [name, element.id]),
        text: ['owned', 'nested', 'ignored', 'island'].map(
          (id) => root.querySelector(`#${id}`)?.textContent,
        ),
      };
    });
    expect(result.read).toEqual(['message']);
    expect(result.ids).toEqual([['owned', 'owned']]);
    expect(result.text).toEqual(['updated', 'nested', 'ignored', 'island']);
  });

  it('rejects duplicate owned refs before any bindings mutate and updates ref lookup after removal', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span id="first" nv:text="message" nv:ref="item" nv:cloak="">before</span><span id="second" nv:ref="item"></span>';
      document.body.append(root);
      let rejected = false;
      try {
        window.nvBindingFixture.applyBindings(
          root,
          () => 'updated',
          () => false,
        );
      } catch {
        rejected = true;
      }
      const unchanged =
        root.querySelector('#first')?.textContent === 'before' &&
        root.querySelector('#first')?.hasAttribute('nv:cloak');
      root.querySelector('#second')?.remove();
      const previous = window.nvBindingFixture.queryRefs(root);
      const first = previous.get('item');
      first?.remove();
      const replacement = document.createElement('span');
      replacement.id = 'replacement';
      replacement.setAttribute('nv:ref', 'item');
      root.append(replacement);
      const current = window.nvBindingFixture.queryRefs(root);
      return {
        rejected,
        unchanged,
        previousId: first?.id,
        previousConnected: first?.isConnected,
        currentId: current.get('item')?.id,
        distinct: current.get('item') !== first,
      };
    });
    expect(result).toEqual({
      rejected: true,
      unchanged: true,
      previousId: 'first',
      previousConnected: false,
      currentId: 'replacement',
      distinct: true,
    });
  });

  it('rejects destructive text bindings over existing controls and owned boundaries', async () => {
    const result = await page.evaluate(() => {
      const cases = [
        '<div nv:text="message"><input value="retained"></div>',
        '<div nv:text="message"><div nv:ignore="">retained</div></div>',
        '<div nv:text="message"><div data-nv-component="child">retained</div></div>',
        '<input value="retained" nv:text="message">',
        '<textarea nv:text="message">retained</textarea>',
        '<select nv:text="message"><option>retained</option></select>',
      ];
      return cases.map((markup) => {
        const root = document.createElement('section');
        root.setAttribute('data-nv-component', 'root');
        root.innerHTML = markup;
        document.body.append(root);
        const before = root.innerHTML;
        let rejected = false;
        try {
          window.nvBindingFixture.applyBindings(
            root,
            () => 'destructive',
            () => false,
          );
        } catch {
          rejected = true;
        }
        return { rejected, unchanged: before === root.innerHTML };
      });
    });
    expect(result).toEqual(
      Array.from({ length: 6 }, () => ({ rejected: true, unchanged: true })),
    );
  });

  it('moves focused controls out of hidden panels and removes temporary focusability after blur', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.id = 'root';
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<div id="panel" nv:show="visible"><input id="field"></div>';
      const outside = document.createElement('button');
      outside.textContent = 'Outside';
      document.body.append(root, outside);
      root.querySelector<HTMLInputElement>('#field')?.focus();
      window.nvBindingFixture.applyBindings(
        root,
        () => false,
        () => false,
      );
      const hidden = {
        active: document.activeElement?.id,
        hidden: root.querySelector('#panel')?.hasAttribute('hidden'),
        aria: root.querySelector('#panel')?.getAttribute('aria-hidden'),
        tabIndex: root.getAttribute('tabindex'),
      };
      outside.focus();
      const restored = !root.hasAttribute('tabindex');
      window.nvBindingFixture.applyBindings(
        root,
        () => true,
        () => false,
      );
      return {
        hidden,
        restored,
        shown: !root.querySelector('#panel')?.hasAttribute('hidden'),
        ariaShown: root.querySelector('#panel')?.getAttribute('aria-hidden'),
      };
    });
    expect(result).toEqual({
      hidden: { active: 'root', hidden: true, aria: 'true', tabIndex: '-1' },
      restored: true,
      shown: true,
      ariaShown: 'false',
    });
  });

  it('hiding the component root moves focus to its visible parent', async () => {
    const result = await page.evaluate(() => {
      const parent = document.createElement('section');
      parent.id = 'parent';
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.setAttribute('nv:show', 'visible');
      root.innerHTML = '<input>';
      parent.append(root);
      document.body.append(parent);
      root.querySelector('input')?.focus();
      window.nvBindingFixture.applyBindings(
        root,
        () => false,
        () => false,
      );
      return {
        hidden: root.hasAttribute('hidden'),
        active: document.activeElement?.id,
        aria: root.getAttribute('aria-hidden'),
      };
    });
    expect(result).toEqual({ hidden: true, active: 'parent', aria: 'true' });
  });

  it('preserves a host tabindex change after a visibility fallback blurs', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML = '<div nv:show="visible"><input></div>';
      const outside = document.createElement('button');
      document.body.append(root, outside);
      root.querySelector('input')?.focus();
      window.nvBindingFixture.applyBindings(
        root,
        () => false,
        () => false,
      );
      const moved = document.activeElement === root;
      root.setAttribute('tabindex', '0');
      outside.focus();
      return { moved, tabindex: root.getAttribute('tabindex') };
    });
    expect(result).toEqual({ moved: true, tabindex: '0' });
  });

  it('shows field and aggregate dirty indicators independently without reading their state', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span id="name" nv:dirty="name">Name changed</span><span id="other" nv:dirty="other">Other changed</span><span id="all" nv:dirty="">Changed</span>';
      document.body.append(root);
      const read = () => {
        throw new Error('Dirty indicator must not read public state');
      };
      const dirty = new Set(['name']);
      window.nvBindingFixture.applyBindings(root, read, (field) =>
        field === undefined ? dirty.size > 0 : dirty.has(field),
      );
      const initial = ['name', 'other', 'all'].map(
        (id) => !root.querySelector(`#${id}`)?.hasAttribute('hidden'),
      );
      dirty.clear();
      window.nvBindingFixture.applyBindings(root, read, (field) =>
        field === undefined ? dirty.size > 0 : dirty.has(field),
      );
      return {
        initial,
        cleared: ['name', 'other', 'all'].map((id) =>
          root.querySelector(`#${id}`)?.hasAttribute('hidden'),
        ),
      };
    });
    expect(result).toEqual({
      initial: [true, false, true],
      cleared: [true, true, true],
    });
  });
});

describe('real-browser nv:class bindings', () => {
  it('toggles only the bound classes, keeps server classes and never writes style', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<li id="item" class="row server" nv:class="active:selected is-done:task.done">Item</li>';
      document.body.append(root);
      const state: Record<string, unknown> = {
        selected: true,
        'task.done': false,
      };
      const apply = () =>
        window.nvBindingFixture.applyBindings(
          root,
          (name) => state[name],
          () => false,
        );
      const item = root.querySelector('#item');
      apply();
      const first = item?.getAttribute('class');
      state['selected'] = false;
      state['task.done'] = true;
      apply();
      return {
        first,
        second: item?.getAttribute('class'),
        style: item?.hasAttribute('style'),
      };
    });
    expect(result).toEqual({
      first: 'row server active',
      second: 'row server is-done',
      style: false,
    });
  });

  it('validates every class value before mutating, so a non-boolean leaves the DOM unchanged', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span id="text" nv:text="message" nv:cloak="">before</span><b id="flag" nv:class="on:flag">Flag</b>';
      document.body.append(root);
      const before = root.innerHTML;
      let message = '';
      try {
        window.nvBindingFixture.applyBindings(
          root,
          (name) => (name === 'message' ? 'changed' : 'yes'),
          () => false,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : 'unknown';
      }
      return { before, after: root.innerHTML, message };
    });
    expect(result.after).toBe(result.before);
    expect(result.message).toContain('boolean');
  });

  it('does not bind classes inside nested Live, ignored or island subtrees', async () => {
    const classes = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<p id="own" nv:class="on:flag"></p><div nv:ignore=""><p id="ignored" nv:class="on:flag"></p></div><div data-nv-island="x"><p id="island" nv:class="on:flag"></p></div>';
      document.body.append(root);
      window.nvBindingFixture.applyBindings(
        root,
        () => true,
        () => false,
      );
      return ['own', 'ignored', 'island'].map((id) =>
        root.querySelector(`#${id}`)?.classList.contains('on'),
      );
    });
    expect(classes).toEqual([true, false, false]);
  });

  it('rejects loading or presentation effects that would own the same class', async () => {
    const errors = await page.evaluate(() => {
      const attempt = (markup: string, check: (root: Element) => void) => {
        const root = document.createElement('section');
        root.setAttribute('data-nv-component', 'root');
        root.innerHTML = markup;
        document.body.append(root);
        try {
          check(root);
          return 'accepted';
        } catch (error) {
          return error instanceof Error ? error.message : 'unknown';
        } finally {
          root.remove();
        }
      };
      return {
        loadingConflict: attempt(
          '<button nv:class="busy:flag" nv:loading.class="busy">Save</button>',
          (root) => window.nvLoadingFixture.validateLoading(root),
        ),
        loadingDistinct: attempt(
          '<button nv:class="done:flag" nv:loading.class="busy">Save</button>',
          (root) => window.nvLoadingFixture.validateLoading(root),
        ),
        offlineConflict: attempt(
          '<p nv:class="dim:flag" nv:offline.class="dim">Status</p>',
          (root) => window.nvPresentationFixture.validatePresentation(root),
        ),
        currentConflict: attempt(
          '<a href="/x" nv:class="active:flag" nv:current="active">Link</a>',
          (root) => window.nvPresentationFixture.validatePresentation(root),
        ),
      };
    });
    expect(errors.loadingConflict).toContain('nv:class');
    expect(errors.loadingDistinct).toBe('accepted');
    expect(errors.offlineConflict).toContain('nv:class');
    expect(errors.currentConflict).toContain('nv:class');
  });
});
