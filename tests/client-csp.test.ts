/**
 * Strict CSP operation in actual Chromium: no inline script or style, no
 * eval, and enforced Trusted Types. A real HTTP Live endpoint answers the
 * bundled client; every HTML sink must go through the `nestvexa` policy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { readFile } from 'node:fs/promises';

declare global {
  interface Window {
    nvViolations: string[];
    nvErrors: string[];
    nvBoots: number;
  }
}

const bundleUrl = new URL('../packages/client/dist/index.js', import.meta.url);
const strict = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
];
let policy = [...strict, 'trusted-types nestvexa'].join('; ');
const id = '22222222-2222-4222-8222-222222222222';
const snapshotToken = 'B'.repeat(43);
const csrf = 'csp-csrf-01234567890123456789012345678901';
interface LiveState {
  count: number;
  query: string;
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function inner(state: LiveState): string {
  return (
    `<output id="count" nv:text="count">${state.count}</output>` +
    '<button id="increment" type="button" nv:click="increment" nv:loading.attr="disabled">Increment</button>' +
    `<label for="query">Query</label><input id="query" nv:model.live.debounce.30ms="query" value="${escape(state.query)}">` +
    `<p id="echo">${escape(state.query)}</p>` +
    '<p id="cloaked" nv:cloak="">Ready</p>' +
    '<span id="status" role="status" nv:loading="" hidden>Saving</span>' +
    '<div nv:ignore=""><span id="widget">widget</span></div>'
  );
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/app.css"><script type="module" src="/boot.js"></script></head><body><main>${body}</main></body></html>`;
}
function component(state: LiveState): string {
  return `<section data-nv-component="${id}" data-nv-name="csp" data-nv-snapshot="${snapshotToken}" data-nv-state="${escape(JSON.stringify(state))}" data-nv-revision="0" data-nv-endpoint="/live/csp" data-nv-csrf="${csrf}">${inner(state)}</section>`;
}
const boot = `import { createLiveClient } from '/index.js';
window.nvViolations = [];
window.nvErrors = [];
window.nvBoots = (window.nvBoots ?? 0) + 1;
document.addEventListener('securitypolicyviolation', (event) => {
  window.nvViolations.push(event.violatedDirective + ' ' + event.blockedURI);
});
const client = createLiveClient({ onError(error) { window.nvErrors.push(error.code ?? error.name); } });
client.mount();`;

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let browser: Browser;
let server: Server;
let base: string;
let current: Page | undefined;
let serverState: LiveState = { count: 0, query: '' };
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const html = (content: string) =>
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': policy,
        })
        .end(content);
    if (request.method === 'GET' && path === '/') {
      html(
        page(
          'Strict CSP',
          `${component({ count: 0, query: '' })}<a id="next" href="/second" nv:navigate="">Second page</a>`,
        ),
      );
      return;
    }
    if (request.method === 'GET' && path === '/second') {
      html(page('Second', '<h1 id="second">Second page</h1>'));
      return;
    }
    if (path === '/app.css') {
      response
        .writeHead(200, { 'content-type': 'text/css' })
        .end('[nv\\:cloak]{display:none}');
      return;
    }
    if (path === '/boot.js' || path === '/index.js') {
      const send = (source: string) =>
        response
          .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          .end(source);
      if (path === '/boot.js') send(boot);
      else
        void readFile(bundleUrl, 'utf8').then(send, () =>
          response.writeHead(404).end(),
        );
      return;
    }
    const action = /^\/live\/csp\/([A-Za-z_]+)$/.exec(path)?.[1];
    if (request.method === 'POST' && action) {
      void body(request).then((raw) => {
        const parsed = JSON.parse(raw) as {
          requestId: string;
          revision: number;
          updates: Partial<LiveState>;
        };
        if (request.headers['x-nestvexa-csrf'] !== csrf) {
          response.writeHead(403).end();
          return;
        }
        const state = Object.assign(serverState, parsed.updates);
        if (action === 'increment') state.count++;
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: parsed.requestId,
            component: { id, name: 'csp', revision: parsed.revision + 1 },
            snapshot: snapshotToken,
            state,
            html: inner(state),
          }),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing CSP fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
afterEach(async () => {
  await current?.close();
  current = undefined;
  serverState = { count: 0, query: '' };
  policy = [...strict, 'trusted-types nestvexa'].join('; ');
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

async function open(): Promise<Page> {
  current = await browser.newPage();
  await current.goto(base);
  await current.waitForFunction(() => window.nvBoots === 1);
  return current;
}

describe('strict CSP and enforced Trusted Types', () => {
  it('morphs, synchronizes models and navigates without a single violation', async () => {
    const target = await open();
    await expect
      .poll(() => target.getAttribute('#cloaked', 'nv:cloak'))
      .toBeNull();
    await target.click('#increment');
    await expect.poll(() => target.textContent('#count')).toBe('1');
    await target.fill('#query', '<b>typed</b>');
    await expect.poll(() => target.textContent('#echo')).toBe('<b>typed</b>');
    expect(
      await target.evaluate(() => document.querySelectorAll('#echo *').length),
    ).toBe(0);
    await target.click('#next');
    await expect.poll(() => target.textContent('#second')).toBe('Second page');
    expect(
      await target.evaluate(() => ({
        violations: window.nvViolations,
        errors: window.nvErrors,
        boots: window.nvBoots,
        path: location.pathname,
      })),
    ).toEqual({ violations: [], errors: [], boots: 1, path: '/second' });
  });

  it('fails closed when the page policy does not allow the nestvexa policy', async () => {
    policy = [...strict, 'trusted-types application'].join('; ');
    const target = await open();
    await target.click('#increment');
    await expect
      .poll(() => target.evaluate(() => window.nvErrors.length))
      .toBeGreaterThan(0);
    expect(
      await target.evaluate(() => ({
        count: document.getElementById('count')?.textContent,
        violations: window.nvViolations.some((entry) =>
          entry.startsWith('trusted-types'),
        ),
        busy: document
          .querySelector('[data-nv-component]')
          ?.getAttribute('aria-busy'),
      })),
    ).toEqual({ count: '0', violations: true, busy: 'false' });
  });
});

describe('CSP-safe runtime source', () => {
  it('ships no dynamic code evaluation in the public bundle', async () => {
    const source = await readFile(bundleUrl, 'utf8');
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Function\b/);
    expect(source).not.toMatch(/\bFunction\s*\(\s*["'`]/);
    expect(source).not.toMatch(/set(?:Timeout|Interval)\s*\(\s*["'`]/);
    expect(source).not.toMatch(/\.(?:outerHTML|insertAdjacentHTML)\b/);
    expect(source).not.toMatch(/document\.write/);
    // Exactly the two documented HTML sinks, both routed through the policy.
    expect(source.match(/\.innerHTML\s*=/g)?.length).toBe(1);
    expect(source.match(/parseFromString\(/g)?.length).toBe(1);
    expect(source).toContain('createPolicy("nestvexa"');
  });
});
