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
    nvMorphFixture: typeof import('../packages/client/dist/morph.js');
  }
}

let browser: Browser;
let server: Server;
let page: Page;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Morph replacement fixture</title><script type="module" src="/fixture.js"></script></head><body><main id="fixture"></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as morph from '/morph.js'; window.nvMorphFixture = morph;",
        );
      return;
    }
    const name = /^\/([a-z][a-z0-9-]*)\.js$/.exec(pathname)?.[1];
    if (!name) {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL(`../packages/client/dist/${name}.js`, import.meta.url),
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
    throw new Error('Missing morph fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvMorphFixture'));
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

describe('actual Chromium replacement and morph lifecycle', () => {
  it.each(['cursor', 'later'])(
    'tears down an incompatible same-key %s node before inserting its replacement',
    async (position) => {
      const result = await page.evaluate((position) => {
        const root = document.getElementById('fixture');
        if (!root) throw new Error('Missing fixture');
        const oldMarkup = '<div id="same"><input></div>';
        const keepMarkup = '<p id="keep">keep</p>';
        root.innerHTML =
          position === 'cursor'
            ? oldMarkup + keepMarkup
            : keepMarkup + oldMarkup;
        const old = root.querySelector('#same');
        const keep = root.querySelector('#keep');
        const incoming = document.createElement('template');
        incoming.innerHTML =
          '<section id="same"><input></section><p id="keep">updated</p>';
        const events: string[] = [];
        window.nvMorphFixture.morphChildren(root, incoming.content, new Map(), {
          beforeRemove: (node) =>
            events.push(`remove:${node.nodeName}:${node.isConnected}`),
          afterInsert: (node) =>
            events.push(
              `insert:${node.nodeName}:${old?.isConnected}:${root.querySelectorAll('#same').length}`,
            ),
        });
        return {
          events,
          order: [...root.children].map((element) => element.id),
          sameKeep: root.querySelector('#keep') === keep,
          tag: root.firstElementChild?.tagName,
          oldConnected: old?.isConnected,
        };
      }, position);
      expect(result).toEqual({
        events: ['remove:DIV:true', 'insert:SECTION:false:1'],
        order: ['same', 'keep'],
        sameKeep: true,
        tag: 'SECTION',
        oldConnected: false,
      });
    },
  );

  it('replaces children, preserves their wrapper and deliberately resets dirty and file inputs', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('fixture');
      if (!root) throw new Error('Missing fixture');
      root.innerHTML =
        '<section id="wrapper"><input id="name" nv:model="name" value="old"><input id="file" type="file"></section>';
      const wrapper = root.firstElementChild;
      const old = root.querySelector<HTMLInputElement>('#name');
      const file = root.querySelector<HTMLInputElement>('#file');
      if (!old || !file) throw new Error('Missing inputs');
      old.value = 'unsaved local edit';
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(['example'], 'example.txt', { type: 'text/plain' }),
      );
      file.files = transfer.files;
      const incoming = document.createElement('template');
      incoming.innerHTML =
        '<section id="wrapper" class="updated" nv:replace=""><input id="name" nv:model="name" value="server"><input id="file" type="file"></section>';
      window.nvMorphFixture.morphChildren(
        root,
        incoming.content,
        new Map([['name', 'unsaved local edit']]),
      );
      return {
        sameWrapper: wrapper === root.firstElementChild,
        className: root.firstElementChild?.className,
        sameInput: old === root.querySelector('#name'),
        value: root.querySelector<HTMLInputElement>('#name')?.value,
        fileCount: root.querySelector<HTMLInputElement>('#file')?.files?.length,
        oldFileCount: file.files.length,
        oldConnected: old.isConnected,
      };
    });
    expect(result).toEqual({
      sameWrapper: true,
      className: 'updated',
      sameInput: false,
      value: 'server',
      fileCount: 0,
      oldFileCount: 1,
      oldConnected: false,
    });
  });

  it('replaces self once with ordered outermost lifecycle callbacks', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('fixture');
      if (!root) throw new Error('Missing fixture');
      root.innerHTML =
        '<section id="wrapper"><div id="nested"><input></div></section>';
      const old = root.firstElementChild;
      const incoming = document.createElement('template');
      incoming.innerHTML =
        '<section id="wrapper" nv:replace.self=""><div id="new"><input></div></section>';
      const events: string[] = [];
      window.nvMorphFixture.morphChildren(root, incoming.content, new Map(), {
        beforeRemove: (node) =>
          events.push(`remove:${(node as Element).id}:${node.isConnected}`),
        afterInsert: (node) =>
          events.push(`insert:${(node as Element).id}:${node.isConnected}`),
      });
      return {
        events,
        distinct: old !== root.firstElementChild,
        oldConnected: old?.isConnected,
        child: root.firstElementChild?.firstElementChild?.id,
      };
    });
    expect(result).toEqual({
      events: ['remove:wrapper:true', 'insert:wrapper:true'],
      distinct: true,
      oldConnected: false,
      child: 'new',
    });
  });

  it.each([
    'nv:ignore=""',
    'data-nv-component="nested"',
    'data-nv-island="widget"',
  ])(
    'retains an existing %s boundary despite an incoming replacement request',
    async (attribute) => {
      const result = await page.evaluate((attribute) => {
        const root = document.getElementById('fixture');
        if (!root) throw new Error('Missing fixture');
        root.innerHTML = `<section id="boundary" ${attribute}><input value="local"></section>`;
        const boundary = root.firstElementChild;
        const child = boundary?.firstElementChild;
        const incoming = document.createElement('template');
        incoming.innerHTML = `<section id="boundary" ${attribute} nv:replace.self=""><input value="server"></section>`;
        let events = 0;
        window.nvMorphFixture.morphChildren(root, incoming.content, new Map(), {
          beforeRemove: () => events++,
          afterInsert: () => events++,
        });
        return {
          same: boundary === root.firstElementChild,
          sameChild: child === root.firstElementChild?.firstElementChild,
          value: root.querySelector<HTMLInputElement>('input')?.value,
          events,
        };
      }, attribute);
      expect(result).toEqual({
        same: true,
        sameChild: true,
        value: 'local',
        events: 0,
      });
    },
  );

  it('resumes ordinary keyed morphing when the incoming declaration removes replace', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('fixture');
      if (!root) throw new Error('Missing fixture');
      root.innerHTML =
        '<section id="wrapper" nv:replace=""><input id="name" nv:model="name" value="before"></section>';
      const old = root.querySelector<HTMLInputElement>('input');
      if (!old) throw new Error('Missing input');
      old.value = 'local';
      const incoming = document.createElement('template');
      incoming.innerHTML =
        '<section id="wrapper"><input id="name" nv:model="name" value="server"></section>';
      window.nvMorphFixture.morphChildren(
        root,
        incoming.content,
        new Map([['name', 'local']]),
      );
      return {
        same: old === root.querySelector('input'),
        value: old.value,
        replaced: root.firstElementChild?.hasAttribute('nv:replace'),
      };
    });
    expect(result).toEqual({ same: true, value: 'local', replaced: false });
  });

  it('removes nested ownership boundaries with one outer subtree notification during explicit ancestor replacement', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('fixture');
      if (!root) throw new Error('Missing fixture');
      root.innerHTML =
        '<section id="wrapper"><div id="old"><div data-nv-component="nested"></div><div nv:ignore=""></div><div data-nv-island="widget"></div></div></section>';
      const incoming = document.createElement('template');
      incoming.innerHTML =
        '<section id="wrapper" nv:replace=""><div id="new"><span>ready</span></div></section>';
      const removed: string[] = [],
        inserted: string[] = [];
      window.nvMorphFixture.morphChildren(root, incoming.content, new Map(), {
        beforeRemove: (node) => removed.push((node as Element).id),
        afterInsert: (node) => inserted.push((node as Element).id),
      });
      return {
        removed,
        inserted,
        nestedRemaining: root.querySelectorAll(
          '[data-nv-component], [data-nv-island], [nv\\:ignore]',
        ).length,
      };
    });
    expect(result).toEqual({
      removed: ['old'],
      inserted: ['new'],
      nestedRemaining: 0,
    });
  });

  it('moves keyed nodes without insertion or removal notifications', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('fixture');
      if (!root) throw new Error('Missing fixture');
      root.innerHTML =
        '<div id="a">A</div><div id="b">B</div><div id="c">C</div>';
      const originals = [...root.children];
      const incoming = document.createElement('template');
      incoming.innerHTML =
        '<div id="c">new C</div><div id="a">new A</div><div id="b">new B</div>';
      let events = 0;
      window.nvMorphFixture.morphChildren(root, incoming.content, new Map(), {
        beforeRemove: () => events++,
        afterInsert: () => events++,
      });
      return {
        events,
        order: [...root.children].map((element) => element.id),
        retained: originals.every((element) => root.contains(element)),
      };
    });
    expect(result).toEqual({
      events: 0,
      order: ['c', 'a', 'b'],
      retained: true,
    });
  });

  it.each(['incoming', 'existing'])(
    'rejects late nested duplicate %s keys before earlier markup or callbacks change',
    async (side) => {
      const result = await page.evaluate((side) => {
        const root = document.getElementById('fixture');
        if (!root) throw new Error('Missing fixture');
        const duplicated =
          '<span data-nv-key="duplicate">one</span><span data-nv-key="duplicate">two</span>';
        root.innerHTML = `<p id="early">before</p><section id="late">${side === 'existing' ? duplicated : '<span>valid</span>'}</section>`;
        const before = root.innerHTML;
        const incoming = document.createElement('template');
        incoming.innerHTML = `<p id="early">after</p><section id="late">${side === 'incoming' ? duplicated : '<span>valid</span>'}</section>`;
        let message = '',
          events = 0;
        try {
          window.nvMorphFixture.morphChildren(
            root,
            incoming.content,
            new Map(),
            { beforeRemove: () => events++, afterInsert: () => events++ },
          );
        } catch (error) {
          message = error instanceof Error ? error.message : 'unknown';
        }
        return { unchanged: before === root.innerHTML, message, events };
      }, side);
      expect(result.unchanged).toBe(true);
      expect(result.events).toBe(0);
      expect(result.message).toContain(`Duplicate ${side} DOM key`);
    },
  );

  it('replaces an ordinary node when incoming markup establishes a new ownership boundary', async () => {
    const result = await page.evaluate(() => {
      const root = document.getElementById('fixture');
      if (!root) throw new Error('Missing fixture');
      root.innerHTML = '<div id="widget"><input value="old"></div>';
      const old = root.firstElementChild;
      const incoming = document.createElement('template');
      incoming.innerHTML =
        '<div id="widget" data-nv-island="chart"><input value="fresh"></div>';
      window.nvMorphFixture.morphChildren(root, incoming.content, new Map());
      return {
        distinct: old !== root.firstElementChild,
        boundary: root.firstElementChild?.getAttribute('data-nv-island'),
        value: root.querySelector<HTMLInputElement>('input')?.value,
      };
    });
    expect(result).toEqual({
      distinct: true,
      boundary: 'chart',
      value: 'fresh',
    });
  });

  it.each([
    '<input nv:replace="">',
    '<textarea nv:replace="">x</textarea>',
    '<select nv:replace=""><option>x</option></select>',
    '<div nv:replace="expression"></div>',
    '<div nv:replace="" nv:replace.self=""></div>',
  ])(
    'rejects invalid replacement declaration %s atomically',
    async (markup) => {
      const result = await page.evaluate((markup) => {
        const root = document.getElementById('fixture');
        if (!root) throw new Error('Missing fixture');
        root.innerHTML = '<p>before</p><section>retained</section>';
        const before = root.innerHTML;
        const incoming = document.createElement('template');
        incoming.innerHTML = `<p>after</p>${markup}`;
        let rejected = false;
        try {
          window.nvMorphFixture.morphChildren(
            root,
            incoming.content,
            new Map(),
          );
        } catch {
          rejected = true;
        }
        return { rejected, unchanged: root.innerHTML === before };
      }, markup);
      expect(result).toEqual({ rejected: true, unchanged: true });
    },
  );
});
