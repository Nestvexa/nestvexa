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
import { parsePresentationDirective } from '../packages/client/dist/presentation.js';

declare global {
  interface Window {
    nvPresentationFixture: typeof import('../packages/client/dist/presentation.js');
  }
}
describe('presentation grammar', () => {
  it('accepts only static offline, current and transition effects', () => {
    expect(
      parsePresentationDirective('nv:offline.class.remove', 'ready'),
    ).toEqual({
      kind: 'offline',
      effect: {
        kind: 'loading',
        mode: 'class',
        remove: true,
        tokens: ['ready'],
      },
    });
    expect(parsePresentationDirective('nv:offline.attr', 'disabled')).toEqual({
      kind: 'offline',
      effect: {
        kind: 'loading',
        mode: 'attr',
        remove: false,
        attribute: 'disabled',
      },
    });
    expect(
      parsePresentationDirective('nv:current.exact', 'active selected'),
    ).toEqual({ kind: 'current', exact: true, tokens: ['active', 'selected'] });
    expect(
      parsePresentationDirective('nv:transition.enter-start', 'transparent'),
    ).toEqual({
      kind: 'transition',
      stage: 'enter-start',
      tokens: ['transparent'],
    });
  });
  it.each([
    ['nv:offline', 'false'],
    ['nv:offline.inverse', ''],
    ['nv:offline.attr', 'onclick'],
    ['nv:offline.attr', 'style'],
    ['nv:offline.attr', 'href'],
    ['nv:offline.remove.class', 'active'],
    ['nv:current', ''],
    ['nv:current.deep', 'active'],
    ['nv:current', 'a a'],
    ['nv:current', 'alert(1)'],
    ['nv:current', 'has:expression'],
    [
      'nv:current',
      Array.from({ length: 17 }, (_, index) => `a${index}`).join(' '),
    ],
    ['nv:transition', 'fade'],
    ['nv:transition.duration.500ms', ''],
    ['nv:transition.enter', '<script>'],
    ['nv:transition.leave-end', 'x'.repeat(65)],
    ['nv:transition.enter-start.start', 'fade'],
  ])('rejects unsafe presentation %s=%s', (name, value) => {
    expect(() => parsePresentationDirective(name, value)).toThrow();
  });
});

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
beforeAll(async () => {
  const assets = new Map(
    ['presentation', 'loading', 'grammar', 'focus'].map((name) => [
      `/${name}.js`,
      new URL(`../packages/client/dist/${name}.js`, import.meta.url),
    ]),
  );
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/' || path.startsWith('/products')) {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Presentation fixture</title><script type="module" src="/fixture.js"></script></head><body><main id="fixture"></main></body></html>',
        );
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          "import * as presentation from '/presentation.js'; window.nvPresentationFixture = presentation;",
        );
      return;
    }
    const asset = assets.get(path);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    void readFile(asset, 'utf8').then(
      (source) =>
        response
          .writeHead(200, { 'content-type': 'text/javascript' })
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
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() =>
    Reflect.has(window, 'nvPresentationFixture'),
  );
});
afterEach(async () => {
  await page.close();
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
});

it('projects offline, inverse, classes and native attributes; request failures remain component scoped', async () => {
  const result = await page.evaluate(() => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><p id="offline" nv:offline>Disconnected</p><p id="online" nv:offline.remove>Connected</p><button id="button" nv:offline.attr="disabled" nv:offline.class="muted">Save</button></section><section id="other" data-nv-component><p id="other-offline" nv:offline>Other disconnected</p></section>',
      );
    const root = document.querySelector('#root');
    const other = document.querySelector('#other');
    const offline = document.querySelector('#offline');
    const online = document.querySelector('#online');
    const button = document.querySelector('#button');
    if (!root || !other || !offline || !online || !button)
      throw new Error('Missing fixture');
    const errors: unknown[] = [];
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => errors.push(error),
      });
    controller.refresh(root);
    controller.refresh(other);
    const initial =
      offline.hasAttribute('hidden') &&
      !online.hasAttribute('hidden') &&
      !button.hasAttribute('disabled');
    controller.setNetworkFailure(root, true);
    const failed =
      !offline.hasAttribute('hidden') &&
      online.hasAttribute('hidden') &&
      button.hasAttribute('disabled') &&
      button.classList.contains('muted') &&
      document.querySelector('#other-offline')?.hasAttribute('hidden');
    window.dispatchEvent(new Event('online'));
    const retained = !offline.hasAttribute('hidden');
    controller.setNetworkFailure(root, false);
    const recovered =
      offline.hasAttribute('hidden') &&
      !button.hasAttribute('disabled') &&
      !button.classList.contains('muted');
    controller.dispose();
    return {
      initial,
      failed,
      retained,
      recovered,
      errors: errors.length,
      restored:
        !offline.hasAttribute('hidden') && !offline.hasAttribute('aria-hidden'),
    };
  });
  expect(result).toEqual({
    initial: true,
    failed: true,
    retained: true,
    recovered: true,
    errors: 0,
    restored: true,
  });
});

it('responds to real browser offline/online events without treating online as a successful request', async () => {
  await page.evaluate(() => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><p id="signal" nv:offline>May be offline</p></section>',
      );
    const root = document.querySelector('[data-nv-component]');
    if (!root) throw new Error('Missing root');
    window.nvPresentationFixture
      .createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      })
      .refresh(root);
  });
  await expect.poll(() => page.locator('#signal').isVisible()).toBe(false);
  await page.context().setOffline(true);
  await expect.poll(() => page.locator('#signal').isVisible()).toBe(true);
  await page.context().setOffline(false);
  await expect.poll(() => page.locator('#signal').isVisible()).toBe(false);
});

it('moves focus before hiding content and restores baselines without clobbering later host writes', async () => {
  const result = await page.evaluate(() => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><div id="online" nv:offline.remove><input id="editor"></div><button id="disabled" disabled nv:offline.attr="disabled">Save</button><p id="class" nv:offline.class="muted"></p></section>',
      );
    const root = document.querySelector('#root');
    const editor = document.querySelector('#editor');
    const disabled = document.querySelector('#disabled');
    const classed = document.querySelector('#class');
    if (!root || !(editor instanceof HTMLElement) || !disabled || !classed)
      throw new Error('Missing fixture');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    controller.refresh(root);
    editor.focus();
    controller.setNetworkFailure(root, true);
    const moved =
      document.activeElement === root && root.getAttribute('tabindex') === '-1';
    classed.classList.remove('muted');
    controller.dispose();
    return {
      moved,
      restored:
        !document.querySelector('#online')?.hasAttribute('hidden') &&
        !root.hasAttribute('tabindex'),
      disabled: disabled.hasAttribute('disabled'),
      hostWrite: !classed.classList.contains('muted'),
    };
  });
  expect(result).toEqual({
    moved: true,
    restored: true,
    disabled: true,
    hostWrite: true,
  });
});

it('keeps nested, ignored and island declarations outside parent ownership and restores moved elements', async () => {
  const result = await page.evaluate(() => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><p id="owned" nv:offline.class="muted"></p><div nv:ignore><p id="ignored" nv:offline="invalid"></p></div><div data-nv-island><p nv:offline="invalid"></p></div><section data-nv-component><p id="nested" nv:offline="invalid"></p></section></section><aside id="outside"></aside>',
      );
    const root = document.querySelector('#root');
    const owned = document.querySelector('#owned');
    const outside = document.querySelector('#outside');
    if (!root || !owned || !outside) throw new Error('Missing fixture');
    const errors: unknown[] = [];
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => errors.push(error),
      });
    controller.setNetworkFailure(root, true);
    const applied = owned.classList.contains('muted');
    outside.append(owned);
    controller.refresh(root);
    const restored = !owned.classList.contains('muted');
    controller.dispose();
    return {
      applied,
      restored,
      errors: errors.length,
      ignored: !document.querySelector('#ignored')?.hasAttribute('hidden'),
      nested: !document.querySelector('#nested')?.hasAttribute('hidden'),
    };
  });
  expect(result).toEqual({
    applied: true,
    restored: true,
    errors: 0,
    ignored: true,
    nested: true,
  });
});

it('matches exact and nested route boundaries, ignores query/hash, and refreshes on history events', async () => {
  const result = await page.evaluate(() => {
    history.replaceState(null, '', '/products/42?query=one#details');
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><a id="nested" href="/products" nv:current="active">Products</a><a id="exact" href="/products" nv:current.exact="active">Exact</a><a id="similar" href="/product" nv:current="active">Similar</a><a id="home" href="/" nv:current="active">Home</a></section>',
      );
    const root = document.querySelector('#root');
    if (!root) throw new Error('Missing root');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    controller.refresh(root);
    const initial = ['nested', 'exact', 'similar', 'home'].map((id) =>
      document.getElementById(id)?.classList.contains('active'),
    );
    history.pushState(null, '', '/products/?another=two');
    window.dispatchEvent(new PopStateEvent('popstate'));
    const next = document.querySelector('#exact')?.classList.contains('active');
    controller.dispose();
    return {
      initial,
      next,
      restored: !document
        .querySelector('#nested')
        ?.classList.contains('active'),
    };
  });
  expect(result).toEqual({
    initial: [true, false, false, false],
    next: true,
    restored: true,
  });
});

it.each([
  '<p nv:offline></p>',
  '<div nv:offline.attr="disabled"></div>',
  '<input type="checkbox" nv:offline.attr="readonly">',
  '<p nv:offline nv:show="visible"></p>',
  '<p nv:offline.class="muted" nv:loading.class="muted"></p>',
  '<p nv:offline.attr="aria-busy" nv:bind="aria-busy:busy"></p>',
  '<a href="javascript:alert(1)" nv:current="active">Bad</a>',
  '<a href="https://foreign.invalid/products" nv:current="active">Bad</a>',
  '<a href="http://name:secret@127.0.0.1/products" nv:current="active">Bad</a>',
  '<a href="/products\n" nv:current="active">Bad</a>',
  '<div nv:current="active"></div>',
])(
  'rejects unsafe presentation markup without applying partial effects: %s',
  async (markup) => {
    // The first row puts visibility on the component itself; all others are children.
    const result = await page.evaluate((html) => {
      const root = document.createElement('section');
      root.setAttribute('data-nv-component', '');
      if (html === '<p nv:offline></p>') root.setAttribute('nv:offline', '');
      else root.innerHTML = `<p id="valid" nv:offline></p>${html}`;
      document.body.append(root);
      let errors = 0;
      const controller =
        window.nvPresentationFixture.createPresentationController({
          window,
          onError: () => {
            errors += 1;
          },
        });
      controller.refresh(root);
      controller.dispose();
      return {
        errors,
        applied: root.querySelector('#valid')?.hasAttribute('hidden') ?? false,
      };
    }, markup);
    expect(result).toEqual({ errors: 1, applied: false });
  },
);

it('runs finite CSS enter/leave stages and restores classes after completion', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.fade { transition: opacity 40ms linear; }.transparent { opacity: 0; }.opaque { opacity: 1; }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><p id="animated" nv:transition.enter="fade" nv:transition.enter-start="transparent" nv:transition.enter-end="opaque" nv:transition.leave="fade" nv:transition.leave-start="opaque" nv:transition.leave-end="transparent">Content</p></section>',
      );
    const animated = document.querySelector('#animated');
    if (!animated) throw new Error('Missing fixture');
    const errors: unknown[] = [];
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => errors.push(error),
      });
    const enter = controller.enter(animated);
    const started =
      animated.classList.contains('fade') &&
      animated.classList.contains('transparent');
    const entered = await enter;
    const cleanEnter = animated.className === '';
    const left = await controller.leave(animated);
    controller.dispose();
    return {
      started,
      entered,
      cleanEnter,
      left,
      cleanLeave: animated.className === '',
      connected: animated.isConnected,
      errors: errors.length,
    };
  });
  expect(result).toEqual({
    started: true,
    entered: true,
    cleanEnter: true,
    left: true,
    cleanLeave: true,
    connected: true,
    errors: 0,
  });
});

it('cancels pending transitions on removal, reentry and disposal; rejects unbounded durations', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.slow { transition: opacity 500ms; }.huge { transition: opacity 10s; }.transparent { opacity: 0; }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><p id="animated" nv:transition.enter="slow" nv:transition.enter-start="transparent">Content</p><p id="huge" nv:transition.enter="huge">Too long</p></section>',
      );
    const animated = document.querySelector('#animated');
    const huge = document.querySelector('#huge');
    if (!animated || !huge) throw new Error('Missing fixture');
    let errors = 0;
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: () => {
          errors += 1;
        },
      });
    const removed = controller.enter(animated);
    controller.remove(animated);
    const first = controller.enter(animated);
    const second = controller.enter(animated);
    controller.dispose();
    const disposed = await Promise.all([removed, first, second]);
    const another = window.nvPresentationFixture.createPresentationController({
      window,
      onError: () => {
        errors += 1;
      },
    });
    const bounded = await another.enter(huge);
    another.dispose();
    return {
      disposed,
      bounded,
      errors,
      clean: animated.className === '' && huge.className === '',
    };
  });
  expect(result).toEqual({
    disposed: [false, false, false],
    bounded: false,
    errors: 1,
    clean: true,
  });
});

it('skips animation when reduced motion is requested', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><p id="animated" nv:transition.enter="fade" nv:transition.enter-start="transparent">Content</p></section>',
      );
    const animated = document.querySelector('#animated');
    if (!animated) throw new Error('Missing fixture');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    const complete = await controller.enter(animated);
    controller.dispose();
    return { complete, clean: animated.className === '' };
  });
  expect(result).toEqual({ complete: true, clean: true });
});

it('animates visibility changes once, defers hidden until leave completes and cancels reversals', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.fade { transition: opacity 70ms linear; }.transparent { opacity: 0; }.opaque { opacity: 1; }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><div id="animated" nv:transition.enter="fade" nv:transition.enter-start="transparent" nv:transition.enter-end="opaque" nv:transition.leave="fade" nv:transition.leave-start="opaque" nv:transition.leave-end="transparent"><input id="editor"></div></section>',
      );
    const animated = document.querySelector('#animated');
    const editor = document.querySelector('#editor');
    if (!animated || !(editor instanceof HTMLElement))
      throw new Error('Missing fixture');
    const errors: unknown[] = [];
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => errors.push(error),
      });
    let writes = 0;
    const apply = (shown: boolean) => () => {
      writes += 1;
      animated.toggleAttribute('hidden', !shown);
      animated.setAttribute('aria-hidden', String(!shown));
    };
    controller.show(animated, true, apply(true));
    editor.focus();
    controller.show(animated, false, apply(false));
    controller.show(animated, false, apply(false));
    const pending =
      !animated.hasAttribute('hidden') &&
      animated.getAttribute('aria-hidden') === 'true' &&
      document.activeElement === animated.closest('[data-nv-component]') &&
      writes === 1;
    controller.show(animated, true, apply(true));
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const reversed =
      !animated.hasAttribute('hidden') &&
      animated.getAttribute('aria-hidden') === 'false' &&
      writes === 2;
    controller.show(animated, false, apply(false));
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const finished =
      animated.hasAttribute('hidden') &&
      writes === 3 &&
      animated.className === '';
    controller.dispose();
    return { pending, reversed, finished, errors: errors.length };
  });
  expect(result).toEqual({
    pending: true,
    reversed: true,
    finished: true,
    errors: 0,
  });
});

it('does not commit a delayed hide after disposal or loss of renderer ownership', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.fade { transition: opacity 70ms; }.transparent { opacity: 0; }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><div id="animated" nv:transition.leave="fade" nv:transition.leave-end="transparent"></div></section><aside id="outside"></aside>',
      );
    const root = document.querySelector('#root');
    const animated = document.querySelector('#animated');
    const outside = document.querySelector('#outside');
    if (!root || !animated || !outside) throw new Error('Missing fixture');
    let writes = 0;
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    controller.show(animated, true, () => {
      animated.removeAttribute('hidden');
    });
    controller.show(animated, false, () => {
      writes += 1;
      animated.setAttribute('hidden', '');
    });
    controller.dispose();
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const disposed =
      writes === 0 &&
      !animated.hasAttribute('hidden') &&
      !animated.hasAttribute('aria-hidden');
    const next = window.nvPresentationFixture.createPresentationController({
      window,
      onError: (error) => {
        throw error;
      },
    });
    next.show(animated, true, () => {
      animated.removeAttribute('hidden');
    });
    next.show(animated, false, () => {
      writes += 1;
      animated.setAttribute('hidden', '');
    });
    outside.append(animated);
    next.refresh(root);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    next.dispose();
    return {
      disposed,
      moved:
        writes === 0 &&
        !animated.hasAttribute('hidden') &&
        !animated.hasAttribute('aria-hidden'),
      clean: animated.className === '',
    };
  });
  expect(result).toEqual({ disposed: true, moved: true, clean: true });
});

it('restores before morph without losing retained visibility intent or committing an old leave', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.fade { transition: opacity 70ms; }.transparent { opacity: 0; }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><div id="animated" nv:transition.enter="fade" nv:transition.enter-start="transparent" nv:transition.leave="fade" nv:transition.leave-end="transparent"></div></section>',
      );
    const root = document.querySelector('#root');
    const animated = document.querySelector('#animated');
    if (!root || !animated) throw new Error('Missing fixture');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    let hiddenWrites = 0;
    const apply = (shown: boolean) => () => {
      if (!shown) hiddenWrites += 1;
      animated.toggleAttribute('hidden', !shown);
      animated.setAttribute('aria-hidden', String(!shown));
    };
    controller.show(animated, true, apply(true));
    controller.show(animated, false, apply(false));
    controller.restore(root);
    // Emulate a retained element receiving a fresh server attribute baseline.
    animated.removeAttribute('hidden');
    animated.removeAttribute('aria-hidden');
    controller.show(animated, true, apply(true));
    const retainedEnter =
      animated.classList.contains('fade') &&
      animated.classList.contains('transparent');
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const noStaleHide = hiddenWrites === 0 && !animated.hasAttribute('hidden');
    controller.restore(root);
    animated.setAttribute('hidden', '');
    controller.show(animated, true, apply(true));
    const reasserted = !animated.hasAttribute('hidden');
    controller.dispose();
    return { retainedEnter, noStaleHide, reasserted };
  });
  expect(result).toEqual({
    retainedEnter: true,
    noStaleHide: true,
    reasserted: true,
  });
});

it('animates a retained leave even when incoming markup already projected hidden', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.fade { transition: opacity 70ms; }.transparent { opacity: 0; }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><div id="animated" nv:transition.leave="fade" nv:transition.leave-end="transparent"></div></section>',
      );
    const root = document.querySelector('#root');
    const animated = document.querySelector('#animated');
    if (!root || !animated) throw new Error('Missing fixture');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    controller.show(animated, true, () => {
      animated.removeAttribute('hidden');
    });
    controller.restore(root);
    animated.setAttribute('hidden', '');
    animated.setAttribute('aria-hidden', 'true');
    const hidden = new Promise<void>((resolve) => {
      controller.show(animated, false, () => {
        animated.setAttribute('hidden', '');
        resolve();
      });
    });
    const pending =
      !animated.hasAttribute('hidden') &&
      animated.getAttribute('aria-hidden') === 'true';
    await hidden;
    controller.dispose();
    return { pending, hidden: animated.hasAttribute('hidden') };
  });
  expect(result).toEqual({ pending: true, hidden: true });
});

it('leaves focused content visible and accessible if its focus fallback fails', async () => {
  const result = await page.evaluate(() => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section id="root" data-nv-component><div id="online" nv:offline.remove><input id="editor"></div></section>',
      );
    const root = document.querySelector('#root');
    const editor = document.querySelector('#editor');
    const online = document.querySelector('#online');
    if (
      !(root instanceof HTMLElement) ||
      !(editor instanceof HTMLElement) ||
      !online
    )
      throw new Error('Missing fixture');
    root.focus = () => undefined;
    let errors = 0;
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: () => {
          errors += 1;
        },
      });
    controller.refresh(root);
    editor.focus();
    controller.setNetworkFailure(root, true);
    const result = {
      visible: !online.hasAttribute('hidden'),
      accessible: online.getAttribute('aria-hidden') === 'false',
      focused: document.activeElement === editor,
      errors,
    };
    controller.dispose();
    return result;
  });
  expect(result).toEqual({
    visible: true,
    accessible: true,
    focused: true,
    errors: 1,
  });
});

it('repeats CSS duration/delay lists according to the transition property list', async () => {
  const result = await page.evaluate(async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>.multi { transition-property: opacity, transform; transition-duration: 20ms; transition-delay: 0ms, 90ms; }.start { opacity: 0; transform: translateX(1px); }</style>',
    );
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><div id="animated" nv:transition.enter="multi" nv:transition.enter-start="start"></div></section>',
      );
    const animated = document.querySelector('#animated');
    if (!animated) throw new Error('Missing fixture');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    const before = performance.now();
    const completed = await controller.enter(animated);
    const elapsed = performance.now() - before;
    controller.dispose();
    return {
      completed,
      waited: elapsed >= 110,
      clean: animated.className === '',
    };
  });
  expect(result).toEqual({ completed: true, waited: true, clean: true });
});

it('cancels a native transition cancellation and restores its temporary classes', async () => {
  const result = await page.evaluate(async () => {
    document
      .querySelector('#fixture')
      ?.insertAdjacentHTML(
        'beforeend',
        '<section data-nv-component><div id="animated" nv:transition.enter="fade" nv:transition.enter-start="transparent"></div></section>',
      );
    const animated = document.querySelector('#animated');
    if (!animated) throw new Error('Missing fixture');
    const controller =
      window.nvPresentationFixture.createPresentationController({
        window,
        onError: (error) => {
          throw error;
        },
      });
    const pending = controller.enter(animated);
    animated.dispatchEvent(new Event('transitioncancel'));
    const completed = await pending;
    controller.dispose();
    return { completed, clean: animated.className === '' };
  });
  expect(result).toEqual({ completed: false, clean: true });
});
