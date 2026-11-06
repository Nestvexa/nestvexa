/**
 * Real-Chromium edge cases for the bundled Live runtime: focus, selection and
 * scroll preservation, accessibility announcements, error recovery UI and
 * listener/node leak checks after many morphs and mount/dispose cycles.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import {
  expectActions,
  mountMatrix,
  openPage,
  releaseAll,
  snapshot,
  startMatrix,
} from './support/live-matrix.js';
import type { MatrixFixture } from './support/live-matrix.js';

declare global {
  interface Window {
    nvListeners: () => { global: number; connected: number; detached: number };
  }
}

let fixture: MatrixFixture;
let page: Page | undefined;
beforeAll(async () => {
  fixture = await startMatrix();
});
afterEach(async () => {
  await page?.evaluate(() => window.nvHarness?.client.dispose());
  await page?.close();
  page = undefined;
});
afterAll(async () => {
  await fixture?.close();
});

async function open(): Promise<Page> {
  page = await openPage(fixture);
  return page;
}
function call(target: Page, action: string): Promise<void> {
  return target.evaluate(
    (name) => window.nvHarness.client.call(window.nvHarness.root, name),
    action,
  );
}

describe('focus, selection and scroll preservation across morphs', () => {
  it('keeps focus, caret and selection direction in an unbound input', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { count: 0 },
      actions: { tick: { increment: 'count' } },
      html: '<output id="count">{{count}}</output><input id="field" aria-label="Field" value="server">',
    });
    await target.fill('#field', 'hello world');
    await target.evaluate(() => {
      const field = document.getElementById('field') as HTMLInputElement;
      field.focus();
      field.setSelectionRange(2, 7, 'backward');
    });
    await call(target, 'tick');
    expect(
      await target.evaluate(() => {
        const field = document.getElementById('field') as HTMLInputElement;
        return {
          count: document.getElementById('count')?.textContent,
          focused: document.activeElement === field,
          value: field.value,
          start: field.selectionStart,
          end: field.selectionEnd,
          direction: field.selectionDirection,
        };
      }),
    ).toEqual({
      count: '1',
      focused: true,
      value: 'hello world',
      start: 2,
      end: 7,
      direction: 'backward',
    });
  });

  it('keeps a textarea selection and a bound draft newer than the response', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { notes: 'server', other: 0 },
      hold: true,
      actions: { tick: { increment: 'other' } },
      html: '<output id="other">{{other}}</output><textarea id="notes" aria-label="Notes" nv:model="notes">{{notes}}</textarea>',
    });
    const sent = call(target, 'tick');
    await expectActions(target, ['tick']);
    // Edit while the request is in flight: the response must not erase it.
    await target.fill('#notes', 'line one\nline two');
    await target.evaluate(() => {
      const notes = document.getElementById('notes') as HTMLTextAreaElement;
      notes.focus();
      notes.setSelectionRange(5, 12);
    });
    await releaseAll(target);
    await sent;
    expect(
      await target.evaluate(() => {
        const notes = document.getElementById('notes') as HTMLTextAreaElement;
        return [
          document.getElementById('other')?.textContent,
          notes.value,
          notes.selectionStart,
          notes.selectionEnd,
          document.activeElement === notes,
          window.nvHarness.client.get(window.nvHarness.root, 'notes'),
        ];
      }),
    ).toEqual(['1', 'line one\nline two', 5, 12, true, 'line one\nline two']);
  });

  it('restores the component scroll container and window scroll', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { rows: 1 },
      rootClass: 'scroller',
      actions: { grow: { increment: 'rows' } },
      html: '<p>{{#rows}}<span id="rows">{{rows}}</span>{{/rows}}</p><div class="tall"></div><button id="grow" type="button" nv:click="grow">Grow</button>',
    });
    await target.evaluate(() => {
      const root = window.nvHarness.root;
      root.scrollTop = 900;
      document.body.style.height = '4000px';
      window.scrollTo(0, 300);
    });
    await call(target, 'grow');
    await call(target, 'grow');
    expect(
      await target.evaluate(() => [
        document.getElementById('rows')?.textContent,
        window.nvHarness.root.scrollTop,
        window.scrollY,
      ]),
    ).toEqual(['3', 900, 300]);
  });

  it('moves focus to the component root when the focused control is removed', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { open: true },
      actions: { close: { toggle: 'open' } },
      html: '{{#open}}<button id="close" type="button" nv:click="close">Close</button>{{/open}}<p>Body</p>',
    });
    await target.press('#close', 'Enter');
    await expect
      .poll(() =>
        target.evaluate(() => [
          document.getElementById('close'),
          document.activeElement === window.nvHarness.root,
        ]),
      )
      .toEqual([null, true]);
    // The temporary focus target is released when focus leaves the root.
    await target.evaluate(() => window.nvHarness.root.blur());
    expect(
      await target.evaluate(() =>
        window.nvHarness.root.getAttribute('tabindex'),
      ),
    ).toBeNull();
  });

  it('keeps focus on a keyed node that moves within its list', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { reversed: false },
      actions: { flip: { toggle: 'reversed' } },
      html: '<ul>{{^reversed}}<li data-nv-key="a"><button id="a" type="button" nv:click="flip">A</button></li><li data-nv-key="b"><button id="b" type="button">B</button></li>{{/reversed}}{{#reversed}}<li data-nv-key="b"><button id="b" type="button">B</button></li><li data-nv-key="a"><button id="a" type="button" nv:click="flip">A</button></li>{{/reversed}}</ul>',
    });
    await target.evaluate(() => {
      Reflect.set(window, 'nvKept', document.getElementById('a'));
    });
    await target.press('#a', 'Enter');
    await expect
      .poll(() =>
        target.evaluate(() => [
          [...document.querySelectorAll('li')].map((item) => item.textContent),
          document.activeElement === Reflect.get(window, 'nvKept'),
        ]),
      )
      .toEqual([['B', 'A'], true]);
  });

  it('never steals focus the user moved while a request was pending', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { count: 0 },
      hold: true,
      actions: { tick: { increment: 'count' } },
      html: '<button id="go" type="button" nv:click="tick">Go</button><input id="later" aria-label="Later"><output id="count">{{count}}</output>',
    });
    await target.click('#go');
    await expectActions(target, ['tick']);
    await target.focus('#later');
    await releaseAll(target);
    await expect.poll(() => target.textContent('#count')).toBe('1');
    expect(await target.evaluate(() => document.activeElement?.id)).toBe(
      'later',
    );
  });

  it('keeps unbound native control state and contenteditable content local', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { count: 0 },
      actions: { tick: { increment: 'count' } },
      html: '<output id="count">{{count}}</output><select id="choice" aria-label="Choice"><option>one</option><option>two</option></select><input id="flag" type="checkbox" aria-label="Flag"><div id="editor" contenteditable="true">server</div>',
    });
    await target.selectOption('#choice', 'two');
    await target.check('#flag');
    await target.evaluate(() => {
      const editor = document.getElementById('editor');
      if (editor) editor.textContent = 'user text';
    });
    await call(target, 'tick');
    expect(
      await target.evaluate(() => [
        document.getElementById('count')?.textContent,
        (document.getElementById('choice') as HTMLSelectElement).value,
        (document.getElementById('flag') as HTMLInputElement).checked,
        document.getElementById('editor')?.textContent,
      ]),
    ).toEqual(['1', 'two', true, 'user text']);
  });
});

describe('accessibility announcements', () => {
  it('updates a retained live region in place so assistive technology announces it', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { message: 'Idle' },
      actions: { save: { set: { message: 'Saved 3 items' } } },
      html: '<p id="status" role="status" aria-live="polite">{{message}}</p><button id="save" type="button" nv:click="save">Save</button>',
    });
    await target.evaluate(() => {
      const status = document.getElementById('status');
      Reflect.set(window, 'nvStatus', status);
      Reflect.set(window, 'nvMutations', []);
      if (status)
        new MutationObserver((records) => {
          const log = Reflect.get(window, 'nvMutations') as string[];
          for (const record of records) log.push(record.type);
        }).observe(status, {
          childList: true,
          characterData: true,
          subtree: true,
        });
    });
    await target.click('#save');
    await expect
      .poll(() => target.textContent('#status'))
      .toBe('Saved 3 items');
    expect(
      await target.evaluate(() => ({
        same:
          document.getElementById('status') === Reflect.get(window, 'nvStatus'),
        role: document.getElementById('status')?.getAttribute('role'),
        mutated: (Reflect.get(window, 'nvMutations') as string[]).length > 0,
      })),
    ).toEqual({ same: true, role: 'status', mutated: true });
  });

  it('exposes busy state on the root and a status element while work is pending', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: {},
      hold: true,
      actions: { save: {} },
      html: '<button id="save" type="button" nv:click="save">Save</button><span id="busy" role="status" nv:loading="">Saving</span>',
    });
    const read = () =>
      target.evaluate(() => [
        window.nvHarness.root.getAttribute('aria-busy'),
        document.getElementById('busy')?.getAttribute('aria-hidden'),
      ]);
    expect(await read()).toEqual(['false', 'true']);
    await target.click('#save');
    await expect.poll(read).toEqual(['true', 'false']);
    await releaseAll(target);
    await expect.poll(read).toEqual(['false', 'true']);
  });

  it('skips leave transitions for users who prefer reduced motion', async () => {
    const target = await open();
    await target.addStyleTag({
      content: '.slow{transition:opacity 2s linear}.faded{opacity:0}',
    });
    const html =
      '<div id="panel" nv:show="open" nv:transition.leave="slow" nv:transition.leave-end="faded">Panel</div><button id="close" type="button" nv:click="close">Close</button>';
    const component = {
      state: { open: true },
      actions: { close: { toggle: 'open' } },
      html,
    } as const;
    await mountMatrix(target, component);
    await target.click('#close');
    await target.waitForTimeout(250);
    // Default motion: the leave phase keeps the panel rendered while it fades.
    expect(await target.getAttribute('#panel', 'hidden')).toBeNull();
    await target.evaluate(() => window.nvHarness.client.dispose());
    await target.emulateMedia({ reducedMotion: 'reduce' });
    await mountMatrix(target, component);
    await target.click('#close');
    await expect
      .poll(() => target.getAttribute('#panel', 'hidden'), { timeout: 1000 })
      .toBe('');
  });

  it('reports errors on the DOM path with a code only, never server text', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: {},
      domErrors: true,
      actions: { save: { status: 500 } },
      html: '<button id="save" type="button" nv:click="save">Save</button>',
    });
    await target.click('#save');
    await expect
      .poll(async () => (await snapshot(target)).events)
      .toContain('nestvexa:error:{"code":"HTTP"}');
  });
});

describe('error recovery UI', () => {
  const html =
    '<output id="count">{{count}}</output><button id="go" type="button" nv:click="increment">Go</button><button id="fail" type="button" nv:click="fail">Fail</button><p id="offline" role="status" nv:offline="">Connection lost</p><span id="busy" nv:loading.class="busy">Busy</span>';
  const read = (target: Page) =>
    target.evaluate(() => ({
      count: document.getElementById('count')?.textContent,
      offline: document.getElementById('offline')?.hidden,
      busy: window.nvHarness.root.getAttribute('aria-busy'),
      busyClass: document.getElementById('busy')?.className,
    }));

  it('suspends after an uncertain server failure and restores pending UI', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { count: 0 },
      actions: { increment: { increment: 'count' }, fail: { status: 500 } },
      html,
    });
    await target.click('#fail');
    await expect
      .poll(async () => (await snapshot(target)).errors)
      .toEqual(['HTTP']);
    await target.click('#go');
    await target.waitForTimeout(150);
    expect(await expectActionsNow(target)).toEqual(['fail']);
    // Not a connectivity failure: the offline hint stays hidden.
    expect(await read(target)).toEqual({
      count: '0',
      offline: true,
      busy: 'false',
      busyClass: '',
    });
  });

  it('keeps the component usable after a recoverable rejection', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { count: 0 },
      actions: { increment: { increment: 'count' }, fail: { status: 422 } },
      html,
    });
    await target.click('#fail');
    await target.click('#go');
    await expectActions(target, ['fail', 'increment']);
    await expect.poll(() => read(target)).toMatchObject({ count: '1' });
    expect((await snapshot(target)).errors).toEqual(['HTTP']);
  });

  it('shows the offline hint after a dropped connection and recovers after remount', async () => {
    const target = await open();
    await mountMatrix(target, {
      state: { count: 0 },
      actions: { increment: { increment: 'count' }, fail: { network: true } },
      html,
    });
    await target.click('#fail');
    await expect.poll(() => read(target)).toMatchObject({ offline: false });
    expect((await snapshot(target)).errors).toEqual(['NETWORK']);
    await target.click('#go');
    await target.waitForTimeout(100);
    expect(await expectActionsNow(target)).toEqual(['fail']);
    // The host reconciles (here: remounts the same authoritative markup).
    await target.evaluate(() => {
      window.nvHarness.client.dispose();
      window.nvHarness.client.mount();
    });
    await target.click('#go');
    await expectActions(target, ['fail', 'increment']);
    await expect
      .poll(() => read(target))
      .toMatchObject({ count: '1', offline: true });
  });

  it.each([
    ['a request deadline', { never: true }, 'TIMEOUT', false],
    ['a malformed envelope', { malformed: true }, 'RESPONSE', true],
    ['a stale revision', { stale: true }, 'RESPONSE', true],
  ] as const)(
    'reports %s with a stable code and rejects queued work',
    async (_name, spec, code, offlineHidden) => {
      const target = await open();
      await mountMatrix(target, {
        state: { count: 0 },
        requestTimeoutMs: 200,
        actions: { increment: { increment: 'count' }, fail: spec },
        html,
      });
      await target.click('#fail');
      await target.click('#go');
      await expect
        .poll(async () => (await snapshot(target)).errors)
        .toEqual([code]);
      await target.waitForTimeout(150);
      expect(await expectActionsNow(target)).toEqual(['fail']);
      expect(await read(target)).toMatchObject({
        count: '0',
        offline: offlineHidden,
        busy: 'false',
      });
    },
  );
});

async function expectActionsNow(target: Page): Promise<string[]> {
  return (await snapshot(target)).requests.map((request) => request.action);
}

describe('memory: listeners and nodes stay bounded', () => {
  async function instrumentedPage(): Promise<Page> {
    const target = await fixture.browser.newPage();
    page = target;
    await target.addInitScript(() => {
      const entries = new Map<
        string,
        { target: WeakRef<EventTarget>; global: boolean }
      >();
      const ids = new WeakMap<object, number>();
      let next = 0;
      const id = (value: object): number => {
        let current = ids.get(value);
        if (current === undefined) {
          current = ++next;
          ids.set(value, current);
        }
        return current;
      };
      const key = (
        target: EventTarget,
        type: string,
        listener: object,
        options: unknown,
      ): string =>
        `${id(target)}:${type}:${id(listener)}:${
          typeof options === 'boolean'
            ? options
            : Boolean(
                options &&
                typeof options === 'object' &&
                Reflect.get(options, 'capture'),
              )
        }`;
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void {
        const tracked = this instanceof Node || this === window;
        const once =
          typeof options === 'object' && options !== null && options.once;
        if (listener && tracked && !once)
          entries.set(key(this, type, listener, options), {
            target: new WeakRef(this),
            global: this === window || this === document,
          });
        add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ): void {
        if (listener) entries.delete(key(this, type, listener, options));
        remove.call(this, type, listener, options);
      };
      window.nvListeners = () => {
        let global = 0;
        let connected = 0;
        let detached = 0;
        for (const entry of entries.values()) {
          const target = entry.target.deref();
          if (!target) continue;
          if (entry.global) global++;
          else if (target instanceof Node && target.isConnected) connected++;
          else detached++;
        }
        return { global, connected, detached };
      };
    });
    await target.goto(fixture.base);
    await target.waitForFunction(() => Reflect.has(window, 'nvMatrixClient'));
    return target;
  }
  const richHtml =
    '<output id="count" nv:text="count">{{count}}</output>' +
    '{{#odd}}<section nv:replace=""><button type="button" nv:click.stop="tick">A</button><input aria-label="Draft" nv:model.live="draft"><span nv:keydown.window.escape="tick">Hotkey</span></section>{{/odd}}' +
    '{{^odd}}<section><button type="button" nv:click.debounce.50ms="tick">B</button><span nv:keydown.document.enter="tick">Hotkey</span><div nv:ignore=""><span>widget</span></div></section>{{/odd}}' +
    '<span nv:loading.delay.100ms="">Busy</span><span nv:dirty="">Dirty</span><a href="/" nv:current="active">Here</a>' +
    '<ul><li data-nv-key="a">A</li><li data-nv-key="b">B {{count}}</li></ul>';

  it('returns to the baseline after 300 morphs with replaced and scoped listeners', async () => {
    const target = await instrumentedPage();
    const cdp = await target.context().newCDPSession(target);
    await cdp.send('Performance.enable');
    const metrics = async (): Promise<Record<string, number>> => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics: values } = await cdp.send('Performance.getMetrics');
      return Object.fromEntries(
        values.map((metric) => [metric.name, metric.value]),
      );
    };
    await mountMatrix(target, {
      state: { count: 0, odd: false, draft: '' },
      actions: { tick: { increment: 'count', toggle: 'odd' } },
      html: richHtml,
    });
    const cycle = (count: number) =>
      target.evaluate(async (total) => {
        for (let index = 0; index < total; index++)
          await window.nvHarness.client.call(window.nvHarness.root, 'tick');
      }, count);
    await cycle(4);
    const listeners = await target.evaluate(() => window.nvListeners());
    // Warm up allocation caches, then require no growth across 200 more cycles.
    await cycle(100);
    // Playwright's injected selector engine adds its own listeners on first use.
    expect(await target.textContent('#count')).toBe('104');
    const before = await metrics();
    await cycle(200);
    expect(await target.textContent('#count')).toBe('304');
    const after = await metrics();
    expect(await target.evaluate(() => window.nvListeners())).toEqual(
      listeners,
    );
    expect(listeners.detached).toBe(0);
    // Small slack covers browser-internal listeners and allocation timing; a
    // per-morph leak would add hundreds of listeners or nodes here.
    expect(after['JSEventListeners'] ?? Infinity).toBeLessThanOrEqual(
      (before['JSEventListeners'] ?? 0) + 4,
    );
    expect(after['Nodes'] ?? Infinity).toBeLessThan(
      (before['Nodes'] ?? 0) + 100,
    );
    await cdp.detach();
  }, 60_000);

  it('releases every page listener after repeated mount/dispose cycles', async () => {
    const target = await instrumentedPage();
    await mountMatrix(target, {
      state: { count: 0, odd: true, draft: '' },
      actions: { tick: { increment: 'count', toggle: 'odd' } },
      html: richHtml,
    });
    await target.evaluate(() => window.nvHarness.client.dispose());
    const baseline = await target.evaluate(() => window.nvListeners());
    const counts = await target.evaluate(() => {
      const mounted = [];
      for (let index = 0; index < 50; index++) {
        window.nvHarness.client.mount();
        mounted.push(window.nvListeners().global);
        window.nvHarness.client.dispose();
        const other = window.nvMatrixClient.createLiveClient();
        other.mount();
        other.dispose();
      }
      return { mounted: new Set(mounted).size, after: window.nvListeners() };
    });
    // Each mount adds the same listener set; each dispose removes all of it.
    expect(counts.mounted).toBe(1);
    expect(counts.after).toEqual(baseline);
  });

  it('cancels timers and scoped listeners when a component subtree is removed', async () => {
    const target = await instrumentedPage();
    await mountMatrix(target, {
      state: { count: 0, odd: false, draft: '' },
      actions: { tick: { increment: 'count', toggle: 'odd' } },
      html: richHtml,
    });
    const mounted = await target.evaluate(() => window.nvListeners());
    await target.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (element) => element.textContent === 'B',
      );
      button?.click();
      window.nvHarness.root.remove();
    });
    await target.waitForTimeout(250);
    expect(await expectActionsNow(target)).toEqual([]);
    const removed = await target.evaluate(() => window.nvListeners());
    // The document-scoped hotkey listener is gone; client root listeners remain.
    expect(removed.global).toBe(mounted.global - 1);
    await target.keyboard.press('Enter');
    await target.waitForTimeout(100);
    expect(await expectActionsNow(target)).toEqual([]);
  });
});
