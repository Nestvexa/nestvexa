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
import { parseObserverDirective } from '../packages/client/dist/observers.js';

declare global {
  interface Window {
    nvObserversFixture: typeof import('../packages/client/dist/observers.js');
    nvObserversSession: {
      controller: import('../packages/client/dist/observers.js').ObserverController;
      calls: string[];
      errors: string[];
      pending: { resolve(): void; reject(reason: Error): void }[];
      hold: boolean;
      fail: boolean;
    };
  }
}

describe('observer directive grammar', () => {
  it('parses explicit actions and bounded polling intervals', () => {
    expect(parseObserverDirective('nv:poll', 'refresh')).toEqual({
      kind: 'poll',
      value: 'refresh',
      intervalMs: 2500,
    });
    expect(parseObserverDirective('nv:poll.1s', 'refresh')).toEqual({
      kind: 'poll',
      value: 'refresh',
      intervalMs: 1000,
    });
    expect(parseObserverDirective('nv:poll.3600000ms', 'refresh')).toEqual({
      kind: 'poll',
      value: 'refresh',
      intervalMs: 3600000,
    });
    expect(parseObserverDirective('nv:intersect', 'load')).toEqual({
      kind: 'intersect',
      value: 'load',
      once: false,
    });
    expect(parseObserverDirective('nv:intersect.once', 'load')).toEqual({
      kind: 'intersect',
      value: 'load',
      once: true,
    });
  });
  it.each([
    'nv:poll.999ms',
    'nv:poll.0s',
    'nv:poll.01s',
    'nv:poll.1.5s',
    'nv:poll.3601s',
    'nv:poll.999999999999999999999ms',
    'nv:poll.keep-alive',
    'nv:poll.visible',
    'nv:poll.1s.2s',
    'nv:intersect.repeat',
    'nv:intersect.once.once',
    'nv:intersect.window',
    'nv:click',
  ])('rejects unsupported configuration %s', (name) =>
    expect(() => parseObserverDirective(name, 'refresh')).toThrow(),
  );
  it.each([
    '',
    'load()',
    'x.y',
    'constructor',
    '__proto__',
    'x y',
    'x;alert(1)',
  ])('rejects expressions and unregistered identifier syntax %s', (action) => {
    expect(() => parseObserverDirective('nv:poll', action)).toThrow();
    expect(() => parseObserverDirective('nv:intersect.once', action)).toThrow();
  });
});

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: Server;
let base: string;
let pageErrors: string[];
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/')
      response
        .writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; object-src 'none'",
        })
        .end(
          '<!doctype html><html lang="en"><head><title>Observer fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
    else if (path === '/fixture.js')
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          "import * as observers from '/observers.js'; window.nvObserversFixture=observers;",
        );
    else if (/^\/(?:observers|grammar)\.js$/.test(path))
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
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing observer fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvObserversFixture'));
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
});
afterEach(async () => {
  if (page)
    await page.evaluate(() => window.nvObserversSession?.controller.dispose());
  if (context) await context.close();
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
  markup = '<div id="component" data-nv-component="counter"><span id="target" nv:poll.1s="refresh"></span></div>',
  options: { hold?: boolean; fail?: boolean; limit?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ markup, options }) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Missing fixture main');
      main.innerHTML = markup;
      const calls: string[] = [];
      const errors: string[] = [];
      const pending: { resolve(): void; reject(reason: Error): void }[] = [];
      const controller = window.nvObserversFixture.createObserverController({
        window,
        invoke(element, action) {
          calls.push(`${element.id}:${action}`);
          if (window.nvObserversSession.fail)
            return Promise.reject(new Error('Host invocation failed'));
          if (window.nvObserversSession.hold)
            return new Promise<void>((resolve, reject) =>
              pending.push({ resolve, reject }),
            );
          return Promise.resolve();
        },
        usable(element) {
          return (
            element
              .closest('[data-nv-component]')
              ?.getAttribute('data-usable') !== 'false'
          );
        },
        onError(error) {
          errors.push(error instanceof Error ? error.message : String(error));
        },
        ...(options.limit === undefined
          ? {}
          : { maxRegistrations: options.limit }),
      });
      window.nvObserversSession = {
        controller,
        calls,
        errors,
        pending,
        hold: options.hold ?? false,
        fail: options.fail ?? false,
      };
      controller.refresh(document);
    },
    { markup, options },
  );
}
async function calls(): Promise<string[]> {
  return page.evaluate(() => window.nvObserversSession.calls);
}
async function tick(milliseconds: number): Promise<void> {
  await page.clock.runFor(milliseconds);
  await page.evaluate(() => Promise.resolve());
}

describe('observer browser lifecycle', () => {
  it('starts after the interval, is idempotent on refresh, and stops after disposal', async () => {
    await mount();
    expect(await calls()).toEqual([]);
    await tick(500);
    await page.evaluate(() =>
      window.nvObserversSession.controller.refresh(document),
    );
    await tick(499);
    expect(await calls()).toEqual([]);
    await tick(1);
    expect(await calls()).toEqual(['target:refresh']);
    await tick(1000);
    expect(await calls()).toHaveLength(2);
    await page.evaluate(() => window.nvObserversSession.controller.dispose());
    await tick(10000);
    expect(await calls()).toHaveLength(2);
    await page.evaluate(() =>
      window.nvObserversSession.controller.refresh(document),
    );
    await tick(1000);
    expect(await calls()).toHaveLength(2);
  });
  it('never overlaps slow invocations and waits a full interval after completion', async () => {
    await mount(undefined, { hold: true });
    await tick(1000);
    await tick(10000);
    expect(await calls()).toHaveLength(1);
    await page.evaluate(() =>
      window.nvObserversSession.pending.shift()?.resolve(),
    );
    await tick(999);
    expect(await calls()).toHaveLength(1);
    await tick(1);
    expect(await calls()).toHaveLength(2);
  });
  it('backs off periodic failures and resets the interval after success', async () => {
    await mount(undefined, { fail: true });
    await tick(1000);
    expect(await calls()).toHaveLength(1);
    await tick(1999);
    expect(await calls()).toHaveLength(1);
    await tick(1);
    expect(await calls()).toHaveLength(2);
    await page.evaluate(() => {
      window.nvObserversSession.fail = false;
    });
    await tick(3999);
    expect(await calls()).toHaveLength(2);
    await tick(1);
    expect(await calls()).toHaveLength(3);
    await tick(1000);
    expect(await calls()).toHaveLength(4);
    expect(await page.evaluate(() => window.nvObserversSession.errors)).toEqual(
      ['Host invocation failed', 'Host invocation failed'],
    );
  });
  it('pauses hidden documents and resumes without a catch-up burst', async () => {
    await mount();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(20000);
    expect(await calls()).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(999);
    expect(await calls()).toEqual([]);
    await tick(1);
    expect(await calls()).toHaveLength(1);
  });
  it('pauses actual offline browsers and resumes with a full interval', async () => {
    await mount();
    await context.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await tick(10000);
    expect(await calls()).toEqual([]);
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);
    await tick(999);
    expect(await calls()).toEqual([]);
    await tick(1);
    expect(await calls()).toHaveLength(1);
  });
  it('does not invoke disabled controls and rechecks the host registration on each tick', async () => {
    await mount(
      '<div data-nv-component="counter"><button id="target" nv:poll.1s="refresh" disabled>Refresh</button></div>',
    );
    await tick(1000);
    expect(await calls()).toEqual([]);
    await page.evaluate(() =>
      document.getElementById('target')?.removeAttribute('disabled'),
    );
    await tick(1000);
    expect(await calls()).toHaveLength(1);
    await page.evaluate(() =>
      document
        .querySelector('[data-nv-component]')
        ?.setAttribute('data-usable', 'false'),
    );
    await tick(1000);
    await page.evaluate(() =>
      document
        .querySelector('[data-nv-component]')
        ?.removeAttribute('data-usable'),
    );
    await tick(1000);
    expect(await calls()).toHaveLength(1);
  });
  it('releases detached, reconfigured, ignored and reparented work before invoking', async () => {
    await mount(
      '<div id="component" data-nv-component="one"><span id="removed" nv:poll.1s="refresh"></span><span id="changed" nv:poll.1s="refresh"></span><span id="ignored" nv:poll.1s="refresh"></span><span id="moved" nv:poll.1s="refresh"></span></div><div id="other" data-nv-component="two"></div>',
    );
    await page.evaluate(() => {
      document.getElementById('removed')?.remove();
      document.getElementById('changed')?.setAttribute('nv:poll.1s', 'other');
      document.getElementById('ignored')?.setAttribute('nv:ignore', '');
      const moved = document.getElementById('moved');
      if (moved) document.getElementById('other')?.append(moved);
    });
    await tick(1000);
    expect(await calls()).toEqual([]);
    await page.evaluate(() =>
      window.nvObserversSession.controller.refresh(document),
    );
    await tick(1000);
    expect(await calls()).toEqual(['changed:other', 'moved:refresh']);
  });
  it('removes scheduled subtree work before DOM replacement', async () => {
    await mount();
    await page.evaluate(() => {
      const root = document.getElementById('component');
      if (root) window.nvObserversSession.controller.remove(root);
    });
    await tick(1000);
    expect(await calls()).toEqual([]);
  });
  it('ignores renderer islands and whole-ignore subtrees, including malformed declarations', async () => {
    await mount(
      '<div data-nv-component="one"><div nv:ignore><span nv:poll.1ms="unsafe()"></span><div data-nv-component="hidden-child" data-usable="false"><span nv:intersect.bad="unsafe()"></span></div></div><div data-nv-island><span nv:intersect.bad="unsafe()"></span></div><span id="target" nv:poll.1s="refresh"></span></div>',
    );
    await tick(1000);
    expect(await calls()).toEqual(['target:refresh']);
  });
  it('does not inspect rejected nested owners while refreshing an admitted ancestor', async () => {
    await mount(
      '<div data-nv-component="one"><span id="target" nv:poll.1s="refresh"></span><div data-nv-component="denied" data-usable="false"><span nv:poll.1ms="unsafe()"></span></div></div>',
    );
    await tick(1000);
    expect(await calls()).toEqual(['target:refresh']);
    await page.evaluate(() =>
      window.nvObserversSession.controller.refresh(
        document.querySelector('[data-nv-component]') ?? document,
      ),
    );
    await tick(1000);
    expect(await calls()).toHaveLength(2);
  });
  it('keeps independently admitted roots active inside a parent whole-ignore slot', async () => {
    await mount(
      '<div data-nv-component="parent"><div nv:ignore><div data-nv-component="child"><span id="child-poll" nv:poll.1s="refresh"></span></div></div></div>',
    );
    await tick(1000);
    expect(await calls()).toEqual(['child-poll:refresh']);
  });
  it('rejects duplicate declarations, confirmation bypasses and registration overflow', async () => {
    await mount();
    const failures = await page.evaluate(() => {
      const root = document.querySelector('[data-nv-component]');
      const target = document.getElementById('target');
      if (!root || !target) throw new Error('Missing fixture root');
      const failures: string[] = [];
      for (const mutation of [
        () => target.setAttribute('nv:poll.2s', 'refresh'),
        () => {
          target.removeAttribute('nv:poll.2s');
          target.setAttribute('nv:confirm', 'Proceed?');
        },
      ]) {
        mutation();
        try {
          window.nvObserversFixture.validateObservers(root);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      return failures;
    });
    expect(failures).toHaveLength(2);
    await tick(1000);
    expect(await calls()).toEqual([]);
    await page.evaluate(() => window.nvObserversSession.controller.dispose());
    await expect(
      mount(
        '<div data-nv-component="one"><span nv:poll="refresh"></span><span nv:poll="refresh"></span></div>',
        { limit: 1 },
      ),
    ).rejects.toThrow('capacity');
    await tick(10000);
    expect(await calls()).toEqual([]);
  });
  it('reports unsupported observer capability before starting any new work', async () => {
    await page.evaluate(() => {
      Object.defineProperty(window, 'IntersectionObserver', {
        configurable: true,
        value: undefined,
      });
    });
    await expect(
      mount(
        '<div data-nv-component="one"><span nv:poll="refresh"></span><span nv:intersect="load"></span></div>',
      ),
    ).rejects.toThrow('IntersectionObserver support');
    await tick(10000);
    expect(await calls()).toEqual([]);
  });
  it('runs actual intersection actions on entry, repeats after exit, and preserves once on refresh', async () => {
    await mount(
      '<div data-nv-component="one"><div id="repeat" style="position:absolute;top:2000px;height:50px;width:50px" nv:intersect="load"></div><div id="once" style="position:absolute;top:2200px;height:50px;width:50px" nv:intersect.once="loadOnce"></div></div>',
    );
    await page.clock.resume();
    await page.evaluate(() => {
      document
        .getElementById('repeat')
        ?.setAttribute(
          'style',
          'position:absolute;top:10px;height:50px;width:50px',
        );
      document
        .getElementById('once')
        ?.setAttribute(
          'style',
          'position:absolute;top:100px;height:50px;width:50px',
        );
    });
    await expect.poll(calls).toEqual(['repeat:load', 'once:loadOnce']);
    await page.evaluate(() => {
      window.nvObserversSession.controller.refresh(document);
      for (const id of ['repeat', 'once'])
        document
          .getElementById(id)
          ?.setAttribute(
            'style',
            'position:absolute;top:2000px;height:50px;width:50px',
          );
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const element = document.getElementById('repeat');
          if (!element) throw new Error('Missing repeat target');
          const probe = new IntersectionObserver((entries) => {
            if (entries.some((entry) => !entry.isIntersecting)) {
              probe.disconnect();
              resolve();
            }
          });
          probe.observe(element);
        }),
    );
    await page.evaluate(() => {
      for (const id of ['repeat', 'once'])
        document
          .getElementById(id)
          ?.setAttribute(
            'style',
            'position:absolute;top:10px;height:50px;width:50px',
          );
    });
    await expect
      .poll(calls)
      .toEqual(['repeat:load', 'once:loadOnce', 'repeat:load']);
  });
  it('does not overlap repeated intersections or replay once after a failed attempt', async () => {
    await mount(
      '<div data-nv-component="one"><div id="target" style="position:absolute;top:10px;height:50px;width:50px" nv:intersect.once="load"></div></div>',
      { hold: true },
    );
    await page.clock.resume();
    await expect.poll(calls).toEqual(['target:load']);
    await page.evaluate(() =>
      window.nvObserversSession.pending.shift()?.reject(new Error('Denied')),
    );
    await expect
      .poll(() => page.evaluate(() => window.nvObserversSession.errors))
      .toEqual(['Denied']);
    await page.evaluate(() => {
      document.getElementById('target')?.setAttribute('hidden', '');
      window.nvObserversSession.controller.refresh(document);
    });
    await page.waitForTimeout(50);
    await page.evaluate(() =>
      document.getElementById('target')?.removeAttribute('hidden'),
    );
    await page.waitForTimeout(50);
    expect(await calls()).toEqual(['target:load']);
  });
  it('does not queue intersection entries during pending work or after disposal', async () => {
    await mount(
      '<div data-nv-component="one"><div id="target" style="position:absolute;top:10px;height:50px;width:50px" nv:intersect="load"></div></div>',
      { hold: true },
    );
    await page.clock.resume();
    await expect.poll(calls).toEqual(['target:load']);
    const move = async (top: number): Promise<void> => {
      await page.evaluate(
        (top) =>
          new Promise<void>((resolve) => {
            const element = document.getElementById('target');
            if (!element) throw new Error('Missing intersection target');
            const probe = new IntersectionObserver((entries) => {
              if (
                entries.some((entry) => entry.isIntersecting === (top === 10))
              ) {
                probe.disconnect();
                resolve();
              }
            });
            probe.observe(element);
            element.setAttribute(
              'style',
              `position:absolute;top:${top}px;height:50px;width:50px`,
            );
          }),
        top,
      );
    };
    await move(2000);
    await move(10);
    expect(await calls()).toEqual(['target:load']);
    await page.evaluate(() =>
      window.nvObserversSession.pending.shift()?.resolve(),
    );
    await move(2000);
    await move(10);
    await expect.poll(calls).toEqual(['target:load', 'target:load']);
    await page.evaluate(() => {
      window.nvObserversSession.controller.dispose();
      window.nvObserversSession.pending
        .shift()
        ?.reject(new Error('Late cancellation'));
    });
    await move(2000);
    await move(10);
    expect(await calls()).toEqual(['target:load', 'target:load']);
    expect(await page.evaluate(() => window.nvObserversSession.errors)).toEqual(
      [],
    );
  });
});
