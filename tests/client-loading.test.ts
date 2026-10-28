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
import {
  parseLoadingDirective,
  parseLoadingTarget,
} from '../packages/client/dist/loading.js';

declare global {
  interface Window {
    nvLoadingFixture: typeof import('../packages/client/dist/loading.js');
  }
}

describe('closed loading directive grammar', () => {
  it('parses visibility, class and attribute modifiers without expressions', () => {
    expect(parseLoadingDirective('nv:loading', '')).toEqual({
      kind: 'loading',
      mode: 'show',
      remove: false,
    });
    expect(parseLoadingDirective('nv:loading.remove', '')).toEqual({
      kind: 'loading',
      mode: 'show',
      remove: true,
    });
    expect(
      parseLoadingDirective('nv:loading.class.remove', '  muted is-pending '),
    ).toEqual({
      kind: 'loading',
      mode: 'class',
      remove: true,
      tokens: ['muted', 'is-pending'],
    });
    expect(parseLoadingDirective('nv:loading.attr', 'disabled')).toEqual({
      kind: 'loading',
      mode: 'attr',
      remove: false,
      attribute: 'disabled',
    });
    expect(
      parseLoadingDirective('nv:loading.attr.remove', 'aria-disabled'),
    ).toEqual({
      kind: 'loading',
      mode: 'attr',
      remove: true,
      attribute: 'aria-disabled',
    });
    expect(parseLoadingTarget('save, increment, $sync')).toEqual([
      'save',
      'increment',
      '$sync',
    ]);
  });
  it.each([
    ['nv:loading', 'save'],
    ['nv:loading.remove', 'x'],
    ['nv:loading.delay', ''],
    ['nv:loading.class.remove.remove', 'busy'],
    ['nv:loading.remove.class', 'busy'],
    ['nv:loading.attr.class', 'disabled'],
    ['nv:loading.class', ''],
    ['nv:loading.class', 'a a'],
    ['nv:loading.class', 'has:expression'],
    ['nv:loading.class', '<script>'],
    ['nv:loading.class', 'x'.repeat(65)],
    [
      'nv:loading.class',
      Array.from({ length: 17 }, (_, i) => `a${i}`).join(' '),
    ],
    ['nv:loading.attr', 'onclick'],
    ['nv:loading.attr', 'style'],
    ['nv:loading.attr', 'href'],
    ['nv:loading.attr', 'disabled:true'],
    ['nv:loading.attr', 'aria-hidden'],
  ])('rejects malformed loading declaration %s=%s', (name, value) => {
    expect(() => parseLoadingDirective(name, value)).toThrow();
  });
  it.each([
    '',
    'save,',
    ',save',
    'save,save',
    'save()',
    '__proto__',
    '_sync',
    '$mount',
    'user.path',
    Array.from({ length: 17 }, (_, i) => `a${i}`).join(','),
  ])('rejects unsafe or ambiguous targets %s', (value) => {
    expect(() => parseLoadingTarget(value)).toThrow();
  });
});

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
beforeAll(async () => {
  const assets = new Map(
    ['loading', 'grammar', 'focus'].map((name) => [
      `/${name}.js`,
      new URL(`../packages/client/dist/${name}.js`, import.meta.url),
    ]),
  );
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Loading fixture</title><script type="module" src="/fixture.js"></script></head><body><main id="fixture"></main></body></html>',
        );
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as loading from '/loading.js'; window.nvLoadingFixture = loading;",
        );
      return;
    }
    const file = assets.get(path);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    void readFile(file, 'utf8').then(
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
    throw new Error('Missing loading fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvLoadingFixture'));
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

describe('actual Chromium reversible loading effects', () => {
  it('restores exact class and attribute baselines without enabling a server-disabled control', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<button id="one" disabled="server" class="existing muted" aria-disabled="false" nv:loading.attr="disabled" nv:loading.class="existing busy" nv:loading.class.remove="muted">Save</button><input id="two" readonly="server" nv:loading.attr.remove="readonly"><span id="three" aria-busy="false" nv:loading.attr="aria-busy"></span>';
      document.body.append(root);
      const one = root.querySelector('#one');
      const two = root.querySelector('#two');
      const three = root.querySelector('#three');
      if (!one || !two || !three) throw new Error('Missing controls');
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map([['save', 1]]));
      const busy = [
        one.getAttribute('disabled'),
        one.className,
        two.getAttribute('readonly'),
        three.getAttribute('aria-busy'),
      ];
      controller.update(root, new Map());
      const idle = [
        one.getAttribute('disabled'),
        one.className,
        two.getAttribute('readonly'),
        three.getAttribute('aria-busy'),
      ];
      controller.dispose();
      return { busy, idle };
    });
    expect(result.busy).toEqual(['', 'existing busy', null, 'true']);
    expect(result.idle).toEqual([
      'server',
      'existing muted',
      'server',
      'false',
    ]);
  });
  it('counts concurrent action targets independently including synchronization', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<span id="all" nv:loading="" hidden></span><span id="save" nv:loading="" nv:target="save" hidden></span><span id="sync" nv:loading="" nv:target="$sync" hidden></span><span id="idle" nv:loading.remove=""></span>';
      document.body.append(root);
      const controller = window.nvLoadingFixture.createLoadingController();
      const state = () =>
        [...root.children].map((element) => [
          element.hasAttribute('hidden'),
          element.getAttribute('aria-hidden'),
        ]);
      controller.update(
        root,
        new Map([
          ['save', 2],
          ['$sync', 1],
        ]),
      );
      const first = state();
      controller.update(root, new Map([['save', 1]]));
      const second = state();
      controller.update(root, new Map([['other', 1]]));
      const third = state();
      controller.update(root, new Map());
      const fourth = state();
      controller.dispose();
      return { first, second, third, fourth };
    });
    expect(result.first).toEqual([
      [false, 'false'],
      [false, 'false'],
      [false, 'false'],
      [true, 'true'],
    ]);
    expect(result.second).toEqual([
      [false, 'false'],
      [false, 'false'],
      [true, 'true'],
      [true, 'true'],
    ]);
    expect(result.third).toEqual([
      [false, 'false'],
      [true, 'true'],
      [true, 'true'],
      [true, 'true'],
    ]);
    expect(result.fourth).toEqual([
      [true, 'true'],
      [true, 'true'],
      [true, 'true'],
      [false, 'false'],
    ]);
  });
  it('preserves ignored, island and nested renderer ownership and prunes reparented effects', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<div nv:ignore=""><button id="ignored" nv:loading.attr="disabled"></button></div><div data-nv-island="x"><button id="island" nv:loading.attr="disabled"></button></div><div data-nv-component="child"><button id="nested" nv:loading.attr="disabled"></button></div><button id="owned" nv:loading.attr="disabled"></button>';
      document.body.append(root);
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map([['save', 1]]));
      const before = [...root.querySelectorAll('button')].map((element) =>
        element.hasAttribute('disabled'),
      );
      const owned = root.querySelector('#owned');
      const ignored = root.querySelector('[nv\\:ignore]');
      if (!owned || !ignored) throw new Error('Missing controls');
      ignored.append(owned);
      controller.prune();
      const pruned = owned.hasAttribute('disabled');
      controller.dispose();
      return { before, pruned };
    });
    expect(result).toEqual({
      before: [false, false, false, true],
      pruned: false,
    });
  });
  it('validates all declarations and counts atomically before changing any existing loading state', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<button id="one" nv:loading.attr="disabled"></button><span id="two" nv:loading="" hidden></span>';
      document.body.append(root);
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map([['save', 1]]));
      const two = root.querySelector('#two');
      if (!two) throw new Error('Missing target');
      two.setAttribute('nv:loading.attr', 'onclick');
      let invalidConfig = false;
      try {
        controller.update(root, new Map());
      } catch {
        invalidConfig = true;
      }
      const afterInvalid = root.innerHTML;
      two.removeAttribute('nv:loading.attr');
      let invalidCount = false;
      try {
        controller.update(root, new Map([['save', -1]]));
      } catch {
        invalidCount = true;
      }
      const retained = root.querySelector('#one')?.hasAttribute('disabled');
      controller.dispose();
      return {
        invalidConfig,
        invalidCount,
        retained,
        active: afterInvalid.includes('disabled=""'),
      };
    });
    expect(result).toEqual({
      invalidConfig: true,
      invalidCount: true,
      retained: true,
      active: true,
    });
  });
  it('rejects conflicting property owners, orphan targets and invalid native attribute hosts', async () => {
    const result = await page.evaluate(() => {
      const cases = [
        '<span nv:target="save"></span>',
        '<span nv:loading="" nv:loading.remove=""></span>',
        '<span nv:loading="" nv:show="visible"></span>',
        '<button nv:loading.attr="disabled" nv:bind="disabled:locked"></button>',
        '<span nv:loading.class="busy" nv:loading.class.remove="busy"></span>',
        '<span nv:loading.attr="disabled"></span>',
        '<button nv:loading.attr="readonly"></button>',
      ];
      const rejected = cases.map((html) => {
        const root = document.createElement('section');
        root.setAttribute('data-nv-component', 'root');
        root.innerHTML = html;
        try {
          window.nvLoadingFixture.validateLoading(root);
          return false;
        } catch {
          return true;
        }
      });
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.setAttribute('nv:loading.attr', 'aria-busy');
      try {
        window.nvLoadingFixture.validateLoading(root);
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
      root.removeAttribute('nv:loading.attr');
      root.setAttribute('nv:loading', '');
      try {
        window.nvLoadingFixture.validateLoading(root);
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
      return rejected;
    });
    expect(result).toEqual(Array(9).fill(true));
  });
  it('rejects readonly on input types where the browser does not enforce it', async () => {
    const rejected = await page.evaluate(() =>
      [
        'checkbox',
        'radio',
        'file',
        'hidden',
        'range',
        'color',
        'button',
        'submit',
        'reset',
        'image',
      ].map((type) => {
        const root = document.createElement('section');
        root.setAttribute('data-nv-component', 'root');
        const input = document.createElement('input');
        input.type = type;
        input.setAttribute('nv:loading.attr', 'readonly');
        root.append(input);
        try {
          window.nvLoadingFixture.validateLoading(root);
          return false;
        } catch {
          return true;
        }
      }),
    );
    expect(rejected).toEqual(Array(10).fill(true));
  });
  it('applies and restores readonly on a native number input and textarea', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<input type="number" nv:loading.attr="readonly"><textarea nv:loading.attr="readonly"></textarea>';
      document.body.append(root);
      const controls = [...root.querySelectorAll('input, textarea')];
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map([['save', 1]]));
      const busy = controls.map(
        (element) =>
          (element as HTMLInputElement | HTMLTextAreaElement).readOnly,
      );
      controller.update(root, new Map());
      const idle = controls.map(
        (element) =>
          (element as HTMLInputElement | HTMLTextAreaElement).readOnly,
      );
      controller.dispose();
      return { busy, idle };
    });
    expect(result).toEqual({ busy: [true, true], idle: [false, false] });
  });
  it('moves focus to the component before hiding a loading visibility target', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<div nv:loading.remove=""><button>Focused action</button></div><button id="next">Next</button>';
      document.body.append(root);
      const button = root.querySelector('div button');
      const next = root.querySelector('#next');
      const area = root.querySelector('div');
      if (
        !(button instanceof HTMLButtonElement) ||
        !(next instanceof HTMLButtonElement) ||
        !area
      )
        throw new Error('Missing focus target');
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map());
      button.focus();
      controller.update(root, new Map([['save', 1]]));
      const moved = document.activeElement === root;
      const hidden = area.hasAttribute('hidden');
      next.focus();
      const temporaryRemoved = !root.hasAttribute('tabindex');
      controller.dispose();
      return { moved, hidden, temporaryRemoved };
    });
    expect(result).toEqual({
      moved: true,
      hidden: true,
      temporaryRemoved: true,
    });
  });

  it.each(['dispose', 'prune', 'host-tabindex'])(
    'releases temporary loading focusability without erasing host writes: %s',
    async (mode) => {
      const result = await page.evaluate((mode) => {
        const root = document.createElement('section');
        root.setAttribute('data-nv-component', 'root');
        root.innerHTML = '<div nv:loading.remove=""><input id="edit"></div>';
        const outside = document.createElement('button');
        document.body.append(root, outside);
        const controller = window.nvLoadingFixture.createLoadingController();
        controller.update(root, new Map());
        root.querySelector<HTMLInputElement>('#edit')?.focus();
        controller.update(root, new Map([['save', 1]]));
        const moved = document.activeElement === root;
        if (mode === 'host-tabindex') {
          root.setAttribute('tabindex', '0');
          outside.focus();
        } else if (mode === 'prune') {
          root.remove();
          controller.prune();
        } else controller.dispose();
        const tabindex = root.getAttribute('tabindex');
        controller.dispose();
        return { moved, tabindex };
      }, mode);
      expect(result).toEqual({
        moved: true,
        tabindex: mode === 'host-tabindex' ? '0' : null,
      });
    },
  );
  it('prunes detached roots and configuration changes before capturing another property', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML = '<button nv:loading.attr="disabled"></button>';
      document.body.append(root);
      const button = root.querySelector('button');
      if (!button) throw new Error('Missing button');
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map([['save', 1]]));
      button.setAttribute('nv:loading.attr', 'aria-busy');
      controller.prune();
      const oldRestored = !button.hasAttribute('disabled');
      controller.update(root, new Map([['save', 1]]));
      const newApplied = button.getAttribute('aria-busy');
      root.remove();
      controller.prune();
      const detachedRestored = !button.hasAttribute('aria-busy');
      document.body.append(root);
      controller.update(root, new Map([['save', 1]]));
      button.removeAttribute('nv:loading.attr');
      controller.prune();
      const removedConfigRestored = !button.hasAttribute('aria-busy');
      controller.dispose();
      return {
        oldRestored,
        newApplied,
        detachedRestored,
        removedConfigRestored,
      };
    });
    expect(result).toEqual({
      oldRestored: true,
      newApplied: 'true',
      detachedRestored: true,
      removedConfigRestored: true,
    });
  });
  it('restores before morph, recaptures new server baselines and keeps later host writes on disposal', async () => {
    const result = await page.evaluate(() => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', 'root');
      root.innerHTML =
        '<button nv:loading.attr="disabled" nv:loading.class="busy"></button>';
      document.body.append(root);
      const button = root.querySelector('button');
      if (!button) throw new Error('Missing button');
      const controller = window.nvLoadingFixture.createLoadingController();
      controller.update(root, new Map([['save', 1]]));
      controller.restore(root);
      const restored = [button.hasAttribute('disabled'), button.className];
      button.setAttribute('disabled', 'server-new');
      controller.update(root, new Map([['save', 1]]));
      controller.update(root, new Map());
      const recaptured = button.getAttribute('disabled');
      controller.update(root, new Map([['save', 1]]));
      button.setAttribute('disabled', 'host-later');
      button.classList.remove('busy');
      controller.dispose();
      const preserved = [button.getAttribute('disabled'), button.className];
      controller.update(root, new Map([['save', 1]]));
      controller.dispose();
      return {
        restored,
        recaptured,
        preserved,
        reusable: button.getAttribute('disabled'),
      };
    });
    expect(result).toEqual({
      restored: [false, ''],
      recaptured: 'server-new',
      preserved: ['host-later', ''],
      reusable: 'host-later',
    });
  });
});
