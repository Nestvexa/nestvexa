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
  copyStreamEndpoints,
  parseStreamDirective,
} from '../packages/client/dist/stream.js';

declare global {
  interface Window {
    nvStreamFixture: typeof import('../packages/client/dist/stream.js');
    nvStreamSession: {
      controller: import('../packages/client/dist/stream.js').StreamController;
      errors: string[];
      result: { ok: boolean; code?: string; chunks?: number } | null;
      run(): void;
    };
  }
}
describe('closed stream grammar', () => {
  it('copies configuration without evaluating accessors or retaining mutable routes', () => {
    const original = { summary: { endpoint: '/read' } };
    const copied = copyStreamEndpoints(original);
    original.summary.endpoint = '/changed';
    expect(copied.summary?.endpoint).toBe('/read');
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.summary)).toBe(true);
    let reads = 0;
    const endpoint = Object.defineProperty({}, 'endpoint', {
      enumerable: true,
      get() {
        reads++;
        return '/read';
      },
    });
    expect(() => copyStreamEndpoints({ summary: endpoint })).toThrow();
    expect(reads).toBe(0);
  });
  it('accepts literal registered stream identifiers and append mode', () => {
    expect(parseStreamDirective('nv:stream', 'summary')).toEqual({
      kind: 'stream',
      id: 'summary',
      append: false,
    });
    expect(parseStreamDirective('nv:stream.append', 'summary')).toEqual({
      kind: 'stream',
      id: 'summary',
      append: true,
    });
  });
  it.each([
    ['nv:stream.html', 'summary'],
    ['nv:stream', '/endpoint'],
    ['nv:stream', 'summary()'],
    ['nv:stream', '__proto__'],
    ['nv:stream', ''],
    ['nv:stream.append.once', 'summary'],
  ])('rejects unsafe %s=%s', (name, value) => {
    expect(() => parseStreamDirective(name, value)).toThrow();
  });
});
let browser: Browser;
let page: Page;
let server: Server;
let base: string;
let closed = 0;
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><html lang="en"><head><title>Text stream fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          "import * as stream from '/stream.js'; window.nvStreamFixture=stream;",
        );
      return;
    }
    if (path.startsWith('/stream/')) {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        const value = JSON.parse(body) as { requestId: string };
        const mode = path.slice('/stream/'.length);
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        let sequence = 0;
        const record = (type: string, fields: Record<string, unknown> = {}) =>
          `${JSON.stringify({ protocol: 'nestvexa-stream/1', requestId: value.requestId, seq: sequence++, type, ...fields })}\n`;
        response.once('close', () => {
          closed += 1;
        });
        if (mode === 'invalid-utf8') {
          response.end(Buffer.from([0xc3, 0x28]));
          return;
        }
        if (mode === 'huge') {
          response.end(record('text', { text: 'x'.repeat(8192) }));
          return;
        }
        if (mode === 'sequence') {
          response.end(record('text', { text: 'unsafe', seq: 3 }));
          return;
        }
        if (mode === 'error') {
          response.end(record('error', { code: 'STREAM_FAILED' }));
          return;
        }
        if (mode === 'total') {
          response.end('x'.repeat(1_048_577));
          return;
        }
        if (mode === 'missing') {
          response.end(record('text', { text: 'partial' }));
          return;
        }
        if (mode === 'split') {
          const text = record('text', { text: 'مرحبا € 😀' }) + record('done');
          const bytes = Buffer.from(text);
          for (const byte of bytes) response.write(Buffer.from([byte]));
          response.end();
          return;
        }
        response.write(
          record('text', { text: '<script>window.streamXss=true</script>' }),
        );
        if (mode === 'hold') return;
        const timer = setTimeout(() => {
          response.end(record('text', { text: 'مرحبا 😀' }) + record('done'));
        }, 200);
        response.once('close', () => clearTimeout(timer));
      });
      return;
    }
    if (!/^\/[a-z][a-z0-9-]*\.js$/.test(path)) {
      response.writeHead(404).end();
      return;
    }
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
  await page.waitForFunction(() => Reflect.has(window, 'nvStreamFixture'));
});
afterEach(async () => {
  await page.evaluate(() => window.nvStreamSession?.controller.dispose());
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
async function mount(mode = 'normal', append = false): Promise<void> {
  await page.evaluate(
    ({ mode, append }) => {
      document
        .querySelector('main')
        ?.insertAdjacentHTML(
          'beforeend',
          `<section data-nv-component id="root"><output id="target" nv:stream${append ? '.append' : ''}="summary">Existing: </output></section>`,
        );
      const root = document.querySelector('#root');
      const target = document.querySelector('#target');
      if (!root || !target) throw new Error('Missing fixture');
      const errors: string[] = [];
      const controller = window.nvStreamFixture.createStreamController({
        window,
        streams: { summary: { endpoint: `/stream/${mode}` } },
        component: (element) =>
          element.closest('[data-nv-component]') === root
            ? {
                root,
                id: 'instance',
                name: 'report',
                snapshot:
                  root.getAttribute('data-stream-snapshot') ?? 'A'.repeat(43),
                revision: Number(
                  root.getAttribute('data-stream-revision') ?? '0',
                ),
                csrf: 'test-csrf',
              }
            : undefined,
        onError: (error) =>
          errors.push(
            error instanceof Error
              ? String(Reflect.get(error, 'code'))
              : 'UNKNOWN',
          ),
      });
      window.nvStreamSession = {
        controller,
        errors,
        result: null,
        run() {
          void controller.start(target).then(
            (result) => {
              window.nvStreamSession.result = {
                ok: true,
                chunks: result.chunks,
              };
            },
            (error: unknown) => {
              window.nvStreamSession.result = {
                ok: false,
                code:
                  error instanceof Error
                    ? String(Reflect.get(error, 'code'))
                    : 'UNKNOWN',
              };
            },
          );
        },
      };
      controller.refresh(root);
    },
    { mode, append },
  );
}
async function run(): Promise<void> {
  await page.evaluate(() => window.nvStreamSession.run());
}
async function result() {
  return page.evaluate(() => window.nvStreamSession.result);
}
it.each([false, true])(
  'renders live chunks as safe text (append=%s) before terminal completion',
  async (append) => {
    await mount('normal', append);
    await run();
    await expect
      .poll(() => page.locator('#target').textContent())
      .toBe(
        `${append ? 'Existing: ' : ''}<script>window.streamXss=true</script>`,
      );
    expect(await result()).toBeNull();
    await expect.poll(result).toEqual({ ok: true, chunks: 2 });
    expect(await page.locator('#target').textContent()).toContain('مرحبا 😀');
    expect(await page.locator('#target script').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.has(window, 'streamXss'))).toBe(
      false,
    );
  },
);
it('decodes multibyte UTF-8 split across actual response chunks', async () => {
  await mount('split');
  await run();
  await expect.poll(result).toEqual({ ok: true, chunks: 1 });
  expect(await page.locator('#target').textContent()).toBe('مرحبا € 😀');
});
it.each(['invalid-utf8', 'sequence', 'huge', 'total', 'missing', 'error'])(
  'rejects %s responses and reports one safe error',
  async (mode) => {
    await mount(mode);
    await run();
    await expect.poll(result).toEqual({ ok: false, code: 'RESPONSE' });
    expect(await page.evaluate(() => window.nvStreamSession.errors)).toEqual([
      'RESPONSE',
    ]);
  },
);
it.each([
  'cancel',
  'remove',
  'dispose',
  'reparent',
  'reconfigure',
  'snapshot',
  'revision',
])(
  'cancels %s without extra error reports or further text writes',
  async (mode) => {
    await mount('hold');
    await run();
    await expect
      .poll(() => page.locator('#target').textContent())
      .toContain('<script>');
    const before = closed;
    await page.evaluate((mode) => {
      const session = window.nvStreamSession;
      const target = document.querySelector('#target');
      const root = document.querySelector('#root');
      if (!target || !root) throw new Error('Missing fixture');
      if (mode === 'cancel') session.controller.cancel(target);
      else if (mode === 'dispose') session.controller.dispose();
      else if (mode === 'remove') {
        session.controller.remove(target);
        target.remove();
      } else if (mode === 'reparent') {
        document.body.append(target);
        session.controller.refresh(root);
      } else if (mode === 'snapshot' || mode === 'revision') {
        root.setAttribute(
          `data-stream-${mode}`,
          mode === 'snapshot' ? 'B'.repeat(43) : '1',
        );
        session.controller.refresh(root);
      } else {
        target.setAttribute('nv:stream', 'unknown');
        try {
          session.controller.refresh(root);
        } catch {
          /* The malformed new registration is rejected after cancelling the old stream. */
        }
      }
    }, mode);
    await expect.poll(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(await page.evaluate(() => window.nvStreamSession.errors)).toEqual(
      [],
    );
    await expect.poll(() => closed > before).toBe(true);
  },
);
it.each([
  'https://foreign.invalid/report',
  'javascript:alert(1)',
  '/report?token=secret',
  '/report#fragment',
  'http://name:secret@localhost/report',
])('rejects unsafe registered endpoint %s', async (endpoint) => {
  const invalid = await page.evaluate((endpoint) => {
    try {
      window.nvStreamFixture.createStreamController({
        window,
        streams: { summary: { endpoint } },
        component: () => undefined,
        onError: () => undefined,
      });
      return false;
    } catch {
      return true;
    }
  }, endpoint);
  expect(invalid).toBe(true);
});
it.each([
  '<button nv:stream="summary"></button>',
  '<output nv:stream="summary"><b>nested</b></output>',
  '<div contenteditable="plaintext-only"><output nv:stream="summary"></output></div>',
  '<div contenteditable="TRUE"><output nv:stream="summary"></output></div>',
  '<output nv:stream="summary" nv:text="field"></output>',
  '<output nv:stream="unknown"></output>',
  '<output nv:stream="summary" nv:stream.append="summary"></output>',
])('rejects invalid target without fetching: %s', async (html) => {
  const rejected = await page.evaluate((html) => {
    const root = document.createElement('section');
    root.setAttribute('data-nv-component', '');
    root.innerHTML = html;
    document.body.append(root);
    try {
      window.nvStreamFixture.validateStreams(root, {
        summary: { endpoint: '/stream/normal' },
      });
      return false;
    } catch {
      return true;
    }
  }, html);
  expect(rejected).toBe(true);
});
