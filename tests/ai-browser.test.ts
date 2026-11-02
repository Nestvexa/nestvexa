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
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';

interface FixtureLog {
  starts: string[];
  cancels: number;
  calls: string[];
  errors: string[];
}
declare global {
  interface Window {
    nvAi: {
      connect(mode: 'ok' | 'hold' | 'error', collect?: string): void;
      dispose(): void;
      log: FixtureLog;
    };
  }
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Assistant fixture</title><script type="module" src="/fixture.js"></script></head><body><main>
<div data-nv-component="c1" id="component">
  <section data-nv-ai id="panel" data-nv-ai-turn="ready" data-nv-ai-turn-id="conv-1:1"
    data-nv-ai-label-streaming="Generating" data-nv-ai-label-done="Answer complete"
    data-nv-ai-label-cancelled="Stopped" data-nv-ai-label-failed="Failed">
    <output id="target" data-nv-ai-stream nv:stream="assistant"></output>
    <button type="button" id="stop" data-nv-ai-cancel disabled>Stop</button>
    <p id="status" data-nv-ai-status role="status"></p>
  </section>
</div></main></body></html>`;

// Fake Live client: records every call; streams resolve, hold until cancelled, or fail.
const fixture = `import { connectAssistant } from '/ai.js';
const log = { starts: [], cancels: 0, calls: [], errors: [] };
let connection = null;
window.addEventListener('error', (event) => log.errors.push(String(event.message)));
window.nvAi = {
  log,
  connect(mode, collect) {
    let release = null;
    const client = {
      startStream(target) {
        log.starts.push(document.getElementById('panel').getAttribute('data-nv-ai-turn-id'));
        if (mode === 'error') return Promise.reject(new Error('STREAM_FAILED'));
        return new Promise((resolve, reject) => {
          if (mode === 'ok') setTimeout(() => resolve({ ok: true }), 40);
          else release = () => reject(new Error('ABORTED'));
        });
      },
      cancelStream() { log.cancels += 1; if (release) release(); },
      call(element, action) { log.calls.push(element.id + ':' + action); return Promise.resolve(); },
    };
    connection = connectAssistant(document.getElementById('component'), client, collect ? { collectAction: collect } : {});
  },
  dispose() { connection?.dispose(); },
};`;

let browser: Browser;
let tab: Page;
let server: Server;
let base: string;
let violations: string[] = [];
beforeAll(async () => {
  const module = await readFile('packages/ai/dist/browser/index.js', 'utf8');
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const csp =
      "default-src 'none'; script-src 'self'; style-src 'none'; base-uri 'none'";
    if (path === '/')
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': csp,
        })
        .end(page);
    else if (path === '/fixture.js' || path === '/ai.js')
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(path === '/ai.js' ? module : fixture);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});
beforeEach(async () => {
  tab = await browser.newPage();
  violations = [];
  tab.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text()))
      violations.push(message.text());
  });
  tab.on('pageerror', (error) => violations.push(error.message));
  await tab.goto(base);
  await tab.waitForFunction(() => 'nvAi' in window);
});
afterEach(async () => {
  await tab?.close();
});
async function log(): Promise<FixtureLog> {
  return tab.evaluate(() => window.nvAi.log);
}
async function updated(): Promise<void> {
  await tab.evaluate(() => {
    document
      .getElementById('component')
      ?.dispatchEvent(new CustomEvent('nestvexa:updated', { bubbles: true }));
  });
}

describe('connectAssistant in real Chromium', () => {
  it('starts one stream per turn, collects once and announces completion', async () => {
    await tab.evaluate(() => window.nvAi.connect('ok'));
    await updated();
    await updated();
    await tab.waitForFunction(() => window.nvAi.log.calls.length === 1);
    expect(await log()).toMatchObject({
      starts: ['conv-1:1'],
      calls: ['component:collect'],
      cancels: 0,
    });
    expect(await tab.locator('#status').textContent()).toBe('Answer complete');
    expect(await tab.locator('#panel').getAttribute('aria-busy')).toBeNull();
    expect(await tab.locator('#stop').isDisabled()).toBe(true);
    // A new server turn id starts exactly one more stream.
    await tab.evaluate(() =>
      document
        .getElementById('panel')
        ?.setAttribute('data-nv-ai-turn-id', 'conv-1:2'),
    );
    await updated();
    await tab.waitForFunction(() => window.nvAi.log.calls.length === 2);
    expect((await log()).starts).toEqual(['conv-1:1', 'conv-1:2']);
    expect(violations).toEqual([]);
  });

  it('does not stream when no turn is ready', async () => {
    await tab.evaluate(() => {
      document.getElementById('panel')?.setAttribute('data-nv-ai-turn', 'idle');
      window.nvAi.connect('ok');
    });
    await updated();
    await tab.waitForTimeout(80);
    expect((await log()).starts).toEqual([]);
  });

  it('stop cancels the stream, reports it and still collects once', async () => {
    await tab.evaluate(() => window.nvAi.connect('hold'));
    await tab.waitForFunction(
      () =>
        document.getElementById('panel')?.getAttribute('aria-busy') === 'true',
    );
    expect(await tab.locator('#stop').isDisabled()).toBe(false);
    expect(await tab.locator('#status').textContent()).toBe('Generating');
    await tab.locator('#stop').click();
    await tab.waitForFunction(() => window.nvAi.log.calls.length === 1);
    expect(await log()).toMatchObject({
      cancels: 1,
      calls: ['component:collect'],
    });
    expect(await tab.locator('#status').textContent()).toBe('Stopped');
    expect(await tab.locator('#stop').isDisabled()).toBe(true);
  });

  it('reports failures without retrying', async () => {
    await tab.evaluate(() => window.nvAi.connect('error', 'refresh'));
    await tab.waitForFunction(() => window.nvAi.log.calls.length === 1);
    await updated();
    await updated();
    await tab.waitForTimeout(80);
    expect(await log()).toMatchObject({
      starts: ['conv-1:1'],
      calls: ['component:refresh'],
    });
    expect(await tab.locator('#status').textContent()).toBe('Failed');
  });

  it('dispose cancels in-flight work and ignores later turns', async () => {
    await tab.evaluate(() => window.nvAi.connect('hold'));
    await tab.waitForFunction(() => window.nvAi.log.starts.length === 1);
    await tab.evaluate(() => {
      window.nvAi.dispose();
      document
        .getElementById('panel')
        ?.setAttribute('data-nv-ai-turn-id', 'conv-1:9');
    });
    await updated();
    await tab.waitForTimeout(80);
    expect(await log()).toMatchObject({
      starts: ['conv-1:1'],
      cancels: 1,
      calls: [],
    });
  });

  it('rejects unsafe collect action names', async () => {
    const error = await tab.evaluate(() => {
      try {
        window.nvAi.connect('ok', 'collect()');
        return null;
      } catch (caught) {
        return String(caught);
      }
    });
    expect(error).toContain('Invalid assistant collect action');
  });
});

describe('browser entry import safety', () => {
  it('imports in Node without touching window or document', async () => {
    const module = await import('../packages/ai/dist/browser/index.js');
    expect(typeof module.connectAssistant).toBe('function');
  });
});
