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
import { parseSortDirective } from '../packages/client/dist/sort.js';

declare global {
  interface Window {
    nvSortFixture: typeof import('../packages/client/dist/sort.js');
    nvSortSession: {
      controller: import('../packages/client/dist/sort.js').SortController;
      requests: {
        list: Element;
        action: string;
        ids: readonly string[];
        input: unknown;
        frozen: boolean;
        resolve(): void;
        reject(error: Error): void;
      }[];
      errors: string[];
      reply(index: number, ids?: readonly string[], failure?: string): void;
      failSync: boolean;
    };
  }
}
describe('sort closed grammar', () => {
  it('parses only action, item identifier and empty handle declarations', () => {
    expect(parseSortDirective('nv:sort', 'reorder')).toEqual({
      kind: 'sort',
      value: 'reorder',
    });
    expect(parseSortDirective('nv:sort.item', '123-task_a')).toEqual({
      kind: 'sort-item',
      id: '123-task_a',
    });
    expect(parseSortDirective('nv:sort.handle', '')).toEqual({
      kind: 'sort-handle',
    });
    expect(parseSortDirective('nv:sort.item', 'a'.repeat(64))).toEqual({
      kind: 'sort-item',
      id: 'a'.repeat(64),
    });
  });
  it.each([
    'nv:sort.once',
    'nv:sort.window',
    'nv:sort.item.once',
    'nv:sort.handle.prevent',
    'nv:sort.bad',
    'nv:sort.item.foo',
    'sort',
  ])('rejects modifiers and unsupported declaration %s', (name) =>
    expect(() => parseSortDirective(name, 'reorder')).toThrow(),
  );
  it.each([
    '',
    'constructor',
    'prototype',
    '__proto__',
    'a'.repeat(65),
    'a.b',
    'a b',
    '<img>',
    '_private',
  ])('rejects invalid stable item ID %s', (id) =>
    expect(() => parseSortDirective('nv:sort.item', id)).toThrow(),
  );
  it.each(['', 'reorder()', 'foo.bar', 'constructor', '__proto__'])(
    'rejects executable action syntax %s',
    (value) => expect(() => parseSortDirective('nv:sort', value)).toThrow(),
  );
  it('rejects data on handles', () =>
    expect(() => parseSortDirective('nv:sort.handle', 'task-a')).toThrow());
});

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function list(
  ids: readonly string[] = ['task-a', 'task-b', 'task-c'],
  id = 'tasks',
): string {
  return `<ol id="${id}" nv:sort="reorder" aria-label="Team tasks">${ids.map((key) => `<li nv:sort.item="${escape(key)}" style="min-height:60px"><button id="${id}-${escape(key)}" type="button" nv:sort.handle aria-label="Move ${escape(key)}"><span>${escape(key)}</span></button><span>Task details</span></li>`).join('')}</ol>`;
}
let browser: Browser;
let page: Page;
let context: BrowserContext;
let server: Server;
let base: string;
let pageErrors: string[];

describe('sort lifecycle in actual Chromium with controlled server acknowledgements', () => {
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
            '<!doctype html><html lang="en"><head><title>Sort fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
          );
      else if (path === '/fixture.js')
        response
          .writeHead(200, { 'content-type': 'text/javascript' })
          .end(
            "import * as sorter from '/sort.js'; window.nvSortFixture=sorter;",
          );
      else if (/^\/(?:sort|grammar)\.js$/.test(path))
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
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing sort fixture port');
    base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  });
  beforeEach(async () => {
    pageErrors = [];
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => Reflect.has(window, 'nvSortFixture'));
  });
  afterEach(async () => {
    if (page) {
      await page.evaluate(() => window.nvSortSession?.controller.dispose());
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
    markup = list(),
    options: { limit?: number; failSync?: boolean } = {},
  ): Promise<void> {
    await page.evaluate(
      ({ markup, options }) => {
        const main = document.querySelector('main');
        if (!main) throw new Error('Missing sort fixture main');
        main.innerHTML = `<h1>Sort fixture</h1><section id="component" data-nv-component="counter">${markup}</section>`;
        const requests: Window['nvSortSession']['requests'] = [];
        const errors: string[] = [];
        const controller = window.nvSortFixture.createSortController({
          window,
          invoke(list, action, input) {
            if (window.nvSortSession.failSync)
              throw new Error('Synchronous host failure');
            return new Promise<void>((resolve, reject) =>
              requests.push({
                list,
                action,
                ids: 'ids' in input ? input.ids : [],
                input,
                frozen:
                  Object.isFrozen(input) &&
                  ('ids' in input
                    ? Object.isFrozen(input.ids)
                    : Object.isFrozen(input.lists) &&
                      Object.values(input.lists).every((ids) =>
                        Object.isFrozen(ids),
                      )),
                resolve,
                reject,
              }),
            );
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
          ...(options.limit === undefined ? {} : { maxLists: options.limit }),
        });
        window.nvSortSession = {
          controller,
          requests,
          errors,
          failSync: options.failSync ?? false,
          reply(index, ids, failure) {
            const request = requests[index];
            if (!request) throw new Error('Missing sort proposal');
            if (failure) {
              request.reject(new Error(failure));
              return;
            }
            // This test fixture stands in for an authoritative server render; the controller never moves items.
            if (ids) {
              const focused = document.activeElement;
              const elements = [...request.list.children];
              for (const id of ids) {
                const element = elements.find(
                  (item) => item.getAttribute('nv:sort.item') === id,
                );
                if (element) request.list.append(element);
              }
              // Model the client's morph focus restoration, not appendChild's focus loss.
              // The public-runtime integration separately exercises the real morph path.
              if (
                focused instanceof HTMLElement &&
                focused.isConnected &&
                document.activeElement === document.body
              )
                focused.focus({ preventScroll: true });
              controller.refresh(document);
            }
            request.resolve();
          },
        };
        controller.refresh(document);
      },
      { markup, options },
    );
  }
  async function proposals() {
    return page.evaluate(() =>
      window.nvSortSession.requests.map(({ action, ids, frozen, list }) => ({
        action,
        ids,
        frozen,
        list: list.id,
      })),
    );
  }
  async function order(id = 'tasks') {
    return page
      .locator(`#${id}`)
      .evaluate((element) =>
        [...element.children].map((child) =>
          child.getAttribute('nv:sort.item'),
        ),
      );
  }
  async function reply(
    index: number,
    ids?: readonly string[],
    failure?: string,
  ): Promise<void> {
    await page.evaluate(
      ({ index, ids, failure }) =>
        window.nvSortSession.reply(index, ids, failure),
      { index, ids, failure },
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[nv\\:sort]')].every(
        (element) => element.getAttribute('aria-busy') !== 'true',
      ),
    );
  }
  it.each([
    ['task-b', 'Alt+ArrowUp', ['task-b', 'task-a', 'task-c']],
    ['task-a', 'Alt+ArrowDown', ['task-b', 'task-a', 'task-c']],
    ['task-c', 'Alt+Home', ['task-c', 'task-a', 'task-b']],
    ['task-a', 'Alt+End', ['task-b', 'task-c', 'task-a']],
  ] as const)(
    'proposes %s with %s, preserving focus and waiting for canonical server order',
    async (id, key, expected) => {
      await mount();
      const handle = page.locator(`#tasks-${id}`);
      await handle.focus();
      await handle.press(key);
      expect(await proposals()).toEqual([
        { action: 'reorder', ids: expected, frozen: true, list: 'tasks' },
      ]);
      expect(await order()).toEqual(['task-a', 'task-b', 'task-c']);
      expect(await handle.getAttribute('aria-disabled')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        `tasks-${id}`,
      );
      expect(await page.locator('#tasks').getAttribute('aria-busy')).toBe(
        'true',
      );
      expect(await page.getByRole('status').textContent()).toContain(
        'Waiting for server',
      );
      await reply(0, expected);
      expect(await order()).toEqual(expected);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        `tasks-${id}`,
      );
      expect(await page.getByRole('status').textContent()).toContain(
        'Order updated',
      );
      expect(await handle.getAttribute('aria-disabled')).toBeNull();
    },
  );
  it('deduplicates pending commands and ignores boundary moves, non-shortcuts and repeated keys', async () => {
    await mount();
    await page.locator('#tasks-task-a').press('Alt+ArrowUp');
    await page.locator('#tasks-task-c').press('Alt+ArrowDown');
    await page.locator('#tasks-task-a').press('Alt+Home');
    await page.locator('#tasks-task-c').press('Alt+End');
    await page.locator('#tasks-task-b').press('ArrowDown');
    await page.locator('#tasks-task-b').press('Alt+Shift+ArrowDown');
    await page.locator('#tasks-task-b').evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          altKey: true,
          key: 'ArrowDown',
          repeat: true,
        }),
      ),
    );
    expect(await proposals()).toEqual([]);
    await page.locator('#tasks-task-b').press('Alt+ArrowDown');
    await page.locator('#tasks-task-b').press('Alt+ArrowUp');
    expect(await proposals()).toHaveLength(1);
    await reply(0, ['task-a', 'task-c', 'task-b']);
    await page.locator('#tasks-task-b').press('Alt+ArrowUp');
    expect(await proposals()).toHaveLength(2);
  });
  it('performs a real native pointer drag from a handle without changing DOM until acknowledgement', async () => {
    await mount();
    await page
      .locator('#tasks-task-a')
      .dragTo(page.locator('#tasks > li').nth(2), {
        targetPosition: { x: 100, y: 50 },
      });
    expect(await proposals()).toEqual([
      {
        action: 'reorder',
        ids: ['task-b', 'task-c', 'task-a'],
        frozen: true,
        list: 'tasks',
      },
    ]);
    expect(await order()).toEqual(['task-a', 'task-b', 'task-c']);
    await reply(0, ['task-b', 'task-c', 'task-a']);
    expect(await order()).toEqual(['task-b', 'task-c', 'task-a']);
  });
  it('does not accept foreign data-transfer identities or external drags', async () => {
    await mount();
    await page.evaluate(() => {
      const target = document.querySelector('#tasks > li');
      if (!target) throw new Error('Missing drop target');
      const data = new DataTransfer();
      data.setData('application/x-nestvexa-sort', 'task-c');
      data.setData('text/plain', '__proto__');
      target.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientY: 20,
        }),
      );
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientY: 20,
        }),
      );
    });
    expect(await proposals()).toEqual([]);
  });
  it('does not allow an internal drag into another list or a drag from non-handle content', async () => {
    await mount(list() + list(['other-a', 'other-b'], 'other'));
    await page
      .locator('#tasks-task-a')
      .dragTo(page.locator('#other > li').nth(1), {
        targetPosition: { x: 100, y: 50 },
      });
    expect(await proposals()).toEqual([]);
    await page
      .locator('#tasks > li')
      .first()
      .locator('span')
      .last()
      .dragTo(page.locator('#tasks > li').last(), {
        targetPosition: { x: 100, y: 50 },
        force: true,
      });
    expect(await proposals()).toEqual([]);
  });
  it('keeps canonical order on rejection, announces failure, restores pending controls and allows explicit retry', async () => {
    await mount();
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    await reply(0, undefined, 'Forbidden reorder');
    expect(await order()).toEqual(['task-a', 'task-b', 'task-c']);
    expect(await page.getByRole('status').textContent()).toContain(
      'Order was not updated',
    );
    expect(await page.evaluate(() => window.nvSortSession.errors)).toEqual([
      'Forbidden reorder',
    ]);
    expect(
      await page.locator('#tasks-task-b').getAttribute('disabled'),
    ).toBeNull();
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect(await proposals()).toHaveLength(2);
  });
  it('handles synchronous callback failure without an unhandled rejection or permanent pending state', async () => {
    await mount(undefined, { failSync: true });
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    await page.waitForFunction(() => window.nvSortSession.errors.length === 1);
    expect(await page.evaluate(() => window.nvSortSession.errors)).toEqual([
      'Synchronous host failure',
    ]);
    expect(await page.locator('#tasks').getAttribute('aria-busy')).toBeNull();
  });
  it.each([
    'ignore',
    'island',
    'owner',
    'action',
    'item',
    'handle',
    'remove',
    'dispose',
  ] as const)(
    'rechecks %s changes before dispatching and does not auto-replay',
    async (change) => {
      await mount();
      await page.evaluate((change) => {
        const root = document.getElementById('component');
        const list = document.getElementById('tasks');
        const handle = document.getElementById('tasks-task-a');
        if (!root || !list || !handle) throw new Error('Missing sort fixture');
        handle.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            altKey: true,
            key: 'ArrowDown',
          }),
        );
        if (change === 'ignore') list.setAttribute('nv:ignore', '');
        else if (change === 'island') list.setAttribute('data-nv-island', '');
        else if (change === 'owner') root.setAttribute('data-usable', 'false');
        else if (change === 'action') list.setAttribute('nv:sort', 'different');
        else if (change === 'item')
          list.firstElementChild?.setAttribute('nv:sort.item', 'different');
        else if (change === 'handle') handle.removeAttribute('nv:sort.handle');
        else if (change === 'remove') list.remove();
        else window.nvSortSession.controller.dispose();
      }, change);
      expect(await proposals()).toEqual([]);
    },
  );
  it('restores owned attributes and listeners on disposal while retaining later host writes', async () => {
    await mount(
      list()
        .replace(
          'id="tasks-task-a"',
          'draggable="false" aria-keyshortcuts="Alt+X" aria-disabled="false" id="tasks-task-a"',
        )
        .replace('id="tasks-task-c"', 'disabled id="tasks-task-c"'),
    );
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    await page.evaluate(() => {
      document
        .getElementById('tasks-task-b')
        ?.setAttribute('draggable', 'false');
      window.nvSortSession.controller.dispose();
      window.nvSortSession.requests[0]?.reject(new Error('Late failure'));
    });
    expect(await page.locator('#tasks-task-a').getAttribute('draggable')).toBe(
      'false',
    );
    expect(
      await page.locator('#tasks-task-a').getAttribute('aria-keyshortcuts'),
    ).toBe('Alt+X');
    expect(
      await page.locator('#tasks-task-a').getAttribute('aria-disabled'),
    ).toBe('false');
    expect(await page.locator('#tasks-task-b').getAttribute('draggable')).toBe(
      'false',
    );
    expect(
      await page.locator('#tasks-task-b').getAttribute('disabled'),
    ).toBeNull();
    expect(await page.locator('#tasks-task-c').getAttribute('disabled')).toBe(
      '',
    );
    expect(await page.getByRole('status').count()).toBe(0);
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect(await proposals()).toHaveLength(1);
    expect(await page.evaluate(() => window.nvSortSession.errors)).toEqual([]);
  });
  it('keeps retained discovery idempotent and releases replaced handles', async () => {
    await mount();
    await page.evaluate(() => {
      window.nvSortSession.controller.refresh(document);
      window.nvSortSession.controller.refresh(document);
    });
    expect(await page.getByRole('status').count()).toBe(1);
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect(await proposals()).toHaveLength(1);
    await reply(0);
    await page.evaluate(() => {
      const handle = document.getElementById('tasks-task-a');
      if (!handle) throw new Error('Missing sort handle');
      const replacement = handle.cloneNode(true);
      handle.replaceWith(replacement);
      window.nvSortSession.controller.refresh(document);
    });
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect(await proposals()).toHaveLength(2);
  });
  it('excludes malformed ignored, island and rejected nested Live owners', async () => {
    await mount(
      list() +
        '<div nv:ignore><div data-nv-component="ignored" data-usable="false"><ol nv:sort="bad()"><li nv:sort.item="__proto__"></li></ol></div></div><div data-nv-island><button nv:sort.bad="bad()"></button></div><div data-nv-component="rejected" data-usable="false"><ol nv:sort="bad()"></ol></div>',
    );
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect(await proposals()).toHaveLength(1);
  });
  it.each([
    list(['task-a', 'task-a']),
    list([]),
    list(Array.from({ length: 201 }, (_, index) => `task-${index}`)),
    list().replace('aria-label="Team tasks"', ''),
    list().replace('aria-label="Team tasks"', 'aria-labelledby="missing"'),
    list().replace('<ol ', '<div ').replace('</ol>', '</div>'),
    list().replace('type="button"', 'type="submit"'),
    list().replace('nv:sort.handle', 'nv:sort.handle="bad"'),
    list().replace('nv:sort.handle', 'nv:sort.handle nv:click="other"'),
    list().replace('nv:sort.item="task-a"', 'nv:sort.item="constructor"'),
    '<button nv:sort.handle type="button">Orphan</button>',
    '<div nv:sort.item="task-a"></div>',
  ])(
    'rejects invalid semantics or unsafe configuration before attaching any handlers',
    async (markup) => {
      await expect(mount(markup)).rejects.toThrow();
      expect(await proposals()).toEqual([]);
    },
  );
  it('accepts labelled role=list markup, referenced labels and numeric identifiers', async () => {
    await mount(
      '<h2 id="task-heading">Team tasks</h2><div id="tasks" role="list" nv:sort="reorder" aria-labelledby="task-heading"><div role="listitem" nv:sort.item="1"><button id="tasks-1" type="button" nv:sort.handle>Move one</button></div><div role="listitem" nv:sort.item="2"><button type="button" nv:sort.handle>Move two</button></div></div>',
    );
    await page.locator('#tasks-1').press('Alt+ArrowDown');
    expect(await proposals()).toEqual([
      { action: 'reorder', ids: ['2', '1'], frozen: true, list: 'tasks' },
    ]);
  });
  it('bounds lists atomically and rejects invalid capacities', async () => {
    for (const limit of [0, -1, 0.5, NaN, Infinity, 257])
      await expect(mount(undefined, { limit })).rejects.toThrow('capacity');
    await expect(
      mount(list() + list(['other-a'], 'other'), { limit: 1 }),
    ).rejects.toThrow('capacity');
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect(await proposals()).toEqual([]);
  });
  it('has no automated axe violations in idle and pending keyboard states', async () => {
    await mount();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator('#tasks-task-a').press('Alt+ArrowDown');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  // Two-dimensional (grid) layouts, connected lists and touch gestures.
  function grid(
    ids: readonly string[] = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'],
    direction: 'ltr' | 'rtl' = 'ltr',
  ): string {
    return `<ul id="grid" dir="${direction}" nv:sort="arrange" aria-label="Photo grid" style="display:grid;grid-template-columns:repeat(3,140px);gap:8px;list-style:none;padding:0">${ids.map((key) => `<li nv:sort.item="${key}" style="height:80px"><button id="grid-${key}" type="button" nv:sort.handle aria-label="Move ${key}">${key}</button></li>`).join('')}</ul>`;
  }
  function board(
    lists: Readonly<Record<string, readonly string[]>> = {
      todo: ['t1', 't2', 't3'],
      done: ['d1', 'd2'],
    },
  ): string {
    return `<div style="display:flex;gap:24px">${Object.entries(lists)
      .map(
        ([key, ids]) =>
          `<ol id="${key}" nv:sort="move" nv:sort.group="${key}" aria-label="${key} column" style="min-height:120px;width:200px">${ids.map((id) => `<li nv:sort.item="${id}" style="min-height:50px"><button id="${key}-${id}" type="button" nv:sort.handle aria-label="Move ${id}">${id}</button></li>`).join('')}</ol>`,
      )
      .join('')}</div>`;
  }
  async function inputs(): Promise<unknown[]> {
    return page.evaluate(() =>
      window.nvSortSession.requests.map(({ input, list }) => ({
        input,
        list: list.id,
      })),
    );
  }
  /** Stand-in for the authoritative server render of connected lists. */
  async function replyLists(
    index: number,
    lists: Readonly<Record<string, readonly string[]>>,
  ): Promise<void> {
    await page.evaluate(
      ({ index, lists }) => {
        const request = window.nvSortSession.requests[index];
        if (!request) throw new Error('Missing sort proposal');
        for (const [key, ids] of Object.entries(lists)) {
          const list = document.getElementById(key);
          for (const id of ids) {
            const item = document.querySelector(`[nv\\:sort\\.item="${id}"]`);
            if (list && item) list.append(item);
          }
        }
        window.nvSortSession.controller.refresh(document);
        request.resolve();
      },
      { index, lists },
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[nv\\:sort]')].every(
        (element) => element.getAttribute('aria-busy') !== 'true',
      ),
    );
  }
  it('parses connected-list keys with the stable identifier grammar', () => {
    expect(parseSortDirective('nv:sort.group', 'todo-1')).toEqual({
      kind: 'sort-group',
      id: 'todo-1',
    });
    for (const value of ['', '__proto__', 'a b', 'a.b', 'x'.repeat(65)])
      expect(() => parseSortDirective('nv:sort.group', value)).toThrow();
    expect(() => parseSortDirective('nv:sort.group.once', 'todo')).toThrow();
  });
  it.each([
    ['ArrowRight', 'g1', ['g2', 'g1', 'g3', 'g4', 'g5', 'g6']],
    ['ArrowLeft', 'g2', ['g2', 'g1', 'g3', 'g4', 'g5', 'g6']],
    ['ArrowDown', 'g1', ['g2', 'g3', 'g4', 'g1', 'g5', 'g6']],
    ['ArrowUp', 'g5', ['g1', 'g5', 'g2', 'g3', 'g4', 'g6']],
  ] as const)(
    'moves within a grid by layout with Alt+%s on %s',
    async (key, id, expected) => {
      await mount(grid());
      await page.locator(`#grid-${id}`).press(`Alt+${key}`);
      expect(await proposals()).toEqual([
        { action: 'arrange', ids: expected, frozen: true, list: 'grid' },
      ]);
    },
  );
  it('mirrors horizontal grid moves right-to-left and ignores boundary rows', async () => {
    await mount(grid(undefined, 'rtl'));
    // In RTL the next item is visually to the left.
    await page.locator('#grid-g1').press('Alt+ArrowLeft');
    expect(await proposals()).toEqual([
      {
        action: 'arrange',
        ids: ['g2', 'g1', 'g3', 'g4', 'g5', 'g6'],
        frozen: true,
        list: 'grid',
      },
    ]);
    await reply(0);
    await page.locator('#grid-g2').press('Alt+ArrowUp');
    await page.locator('#grid-g5').press('Alt+ArrowDown');
    expect(await proposals()).toHaveLength(1);
  });
  it('leaves Alt+Left/Right to the page in a vertical list', async () => {
    await mount();
    const prevented = await page.locator('#tasks-task-a').evaluate((handle) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        altKey: true,
        key: 'ArrowRight',
      });
      handle.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    expect(await proposals()).toEqual([]);
  });
  it('drops by the horizontal midpoint of a grid cell with a real native drag', async () => {
    await mount(grid());
    const cell = page.locator('#grid > li').nth(2);
    const bounds = await cell.boundingBox();
    if (!bounds) throw new Error('Missing grid geometry');
    await page.locator('#grid-g1').dragTo(cell, {
      targetPosition: { x: bounds.width - 4, y: bounds.height / 2 },
    });
    expect(await proposals()).toEqual([
      {
        action: 'arrange',
        ids: ['g2', 'g3', 'g1', 'g4', 'g5', 'g6'],
        frozen: true,
        list: 'grid',
      },
    ]);
  });
  it('moves an item to a connected list by keyboard, pending both lists until the server renders', async () => {
    await mount(board());
    await page.locator('#todo-t2').press('Alt+Shift+ArrowRight');
    expect(await inputs()).toEqual([
      {
        input: {
          item: 't2',
          lists: { todo: ['t1', 't3'], done: ['d1', 't2', 'd2'] },
        },
        list: 'done',
      },
    ]);
    expect(await proposals()).toEqual([
      { action: 'move', ids: [], frozen: true, list: 'done' },
    ]);
    expect(await page.locator('#todo').getAttribute('aria-busy')).toBe('true');
    expect(await page.locator('#done').getAttribute('aria-busy')).toBe('true');
    expect(await page.locator('#todo-t1').getAttribute('aria-disabled')).toBe(
      'true',
    );
    await expect
      .poll(() => page.locator('#done + [role="status"]').textContent())
      .toBe(
        'Moving Move t2 to position 2 of 3 in done column. Waiting for server.',
      );
    // The DOM does not move until the authoritative render.
    expect(await order('todo')).toEqual(['t1', 't2', 't3']);
    await replyLists(0, { todo: ['t1', 't3'], done: ['d1', 't2', 'd2'] });
    expect(await order('done')).toEqual(['d1', 't2', 'd2']);
    expect(await page.locator('#done + [role="status"]').textContent()).toBe(
      'Order updated for done column.',
    );
    // No list before the first one; a move within a connected list names one list.
    await page.locator('#todo-t1').press('Alt+Shift+ArrowLeft');
    await page.locator('#todo-t1').press('Alt+ArrowDown');
    expect((await inputs()).slice(1)).toEqual([
      { input: { item: 't1', lists: { todo: ['t3', 't1'] } }, list: 'todo' },
    ]);
  });
  it('drags into a connected list and onto an empty connected list, never into an unconnected one', async () => {
    await mount(
      board({ todo: ['t1', 't2'], done: [] }) + list(['task-a'], 'tasks'),
    );
    await page.locator('#todo-t1').dragTo(page.locator('#done'), {
      targetPosition: { x: 100, y: 60 },
    });
    expect(await inputs()).toEqual([
      {
        input: { item: 't1', lists: { todo: ['t2'], done: ['t1'] } },
        list: 'done',
      },
    ]);
    await replyLists(0, { done: ['t1'] });
    await page.locator('#todo-t2').dragTo(page.locator('#done > li').first(), {
      targetPosition: { x: 20, y: 4 },
    });
    expect((await inputs())[1]).toEqual({
      input: { item: 't2', lists: { todo: [], done: ['t2', 't1'] } },
      list: 'done',
    });
    await replyLists(1, { done: ['t2', 't1'] });
    // The emptied connected list remains registered and accepts items again
    // (handle IDs keep the column they were rendered in).
    await page.locator('#todo-t1').dragTo(page.locator('#todo'), {
      targetPosition: { x: 100, y: 60 },
    });
    expect(await inputs()).toHaveLength(3);
    await replyLists(2, { todo: ['t1'] });
    await page.locator('#todo-t1').dragTo(page.locator('#tasks > li').first(), {
      targetPosition: { x: 100, y: 50 },
    });
    expect(await inputs()).toHaveLength(3);
  });
  it.each([
    ['a group outside a list', '<div nv:sort.group="todo"></div>' + list()],
    ['duplicate keys', board({ todo: ['t1'] }) + board({ todo: ['t2'] })],
    [
      'an item ID shared across connected lists',
      board({ todo: ['same'], done: ['same'] }),
    ],
  ])('rejects %s before attaching handlers', async (_name, markup) => {
    await expect(mount(markup)).rejects.toThrow();
    expect(await proposals()).toEqual([]);
  });
  async function touchGesture(
    from: string,
    to: { readonly selector: string; readonly x: number; readonly y: number },
    pointerType = 'touch',
  ): Promise<void> {
    await page.evaluate(
      ({ from, to, pointerType }) => {
        const handle = document.querySelector(from);
        const target = document.querySelector(to.selector);
        if (!handle || !target) throw new Error('Missing touch fixture');
        const start = handle.getBoundingClientRect();
        const end = target.getBoundingClientRect();
        const init = (x: number, y: number): PointerEventInit => ({
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType,
          isPrimary: true,
          button: 0,
          clientX: x,
          clientY: y,
        });
        const x = start.left + start.width / 2;
        const y = start.top + start.height / 2;
        handle.dispatchEvent(new PointerEvent('pointerdown', init(x, y)));
        document.dispatchEvent(
          new PointerEvent('pointermove', init(x, y + 20)),
        );
        const destination = init(end.left + to.x, end.top + to.y);
        document.dispatchEvent(new PointerEvent('pointermove', destination));
        handle.dispatchEvent(new PointerEvent('pointerup', destination));
      },
      { from, to, pointerType },
    );
  }
  it('reorders and moves across connected lists with touch pointers, ignoring taps, mice and cancelled gestures', async () => {
    await mount(board());
    expect(
      await page
        .locator('#todo-t1')
        .evaluate((handle) => handle.style.touchAction),
    ).toBe('none');
    await touchGesture('#todo-t1', {
      selector: '#todo > li:nth-child(3)',
      x: 10,
      y: 45,
    });
    expect(await inputs()).toEqual([
      {
        input: { item: 't1', lists: { todo: ['t2', 't3', 't1'] } },
        list: 'todo',
      },
    ]);
    await replyLists(0, { todo: ['t2', 't3', 't1'] });
    await touchGesture(
      '#todo-t3',
      { selector: '#done > li:nth-child(1)', x: 10, y: 4 },
      'pen',
    );
    expect((await inputs())[1]).toEqual({
      input: {
        item: 't3',
        lists: { todo: ['t2', 't1'], done: ['t3', 'd1', 'd2'] },
      },
      list: 'done',
    });
    await replyLists(1, { done: ['t3', 'd1', 'd2'] });
    // A mouse uses native dragging instead; a tap and a cancelled gesture propose nothing.
    await touchGesture(
      '#todo-t2',
      { selector: '#done > li:nth-child(1)', x: 10, y: 4 },
      'mouse',
    );
    await page.locator('#todo-t2').evaluate((handle) => {
      const at = handle.getBoundingClientRect();
      const init: PointerEventInit = {
        bubbles: true,
        pointerId: 9,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        clientX: at.left + 4,
        clientY: at.top + 4,
      };
      handle.dispatchEvent(new PointerEvent('pointerdown', init));
      handle.dispatchEvent(new PointerEvent('pointerup', init));
      handle.dispatchEvent(new PointerEvent('pointerdown', init));
      document.dispatchEvent(
        new PointerEvent('pointermove', { ...init, clientY: at.top + 200 }),
      );
      document.dispatchEvent(new PointerEvent('pointercancel', init));
      document.dispatchEvent(
        new PointerEvent('pointerup', { ...init, clientY: at.top + 200 }),
      );
    });
    expect(await inputs()).toHaveLength(2);
    await page.evaluate(() => window.nvSortSession.controller.dispose());
    expect(
      await page
        .locator('#todo-t2')
        .evaluate((handle) => handle.style.touchAction),
    ).toBe('');
  });
  it('accepts a real Chromium touchscreen drag on a handle', async () => {
    await mount(board());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    const from = await page.locator('#todo-t1').boundingBox();
    const to = await page.locator('#done > li').last().boundingBox();
    if (!from || !to) throw new Error('Missing touch geometry');
    const point = (x: number, y: number) => [{ x, y, id: 1 }];
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: point(x, y),
    });
    for (let step = 1; step <= 5; step++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point(
          x + ((to.x + 20 - x) * step) / 5,
          y + ((to.y + to.height - 5 - y) * step) / 5,
        ),
      });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect.poll(inputs).toEqual([
      {
        input: {
          item: 't1',
          lists: { todo: ['t2', 't3'], done: ['d1', 'd2', 't1'] },
        },
        list: 'done',
      },
    ]);
  });
});
