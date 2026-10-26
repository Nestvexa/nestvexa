import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';

let server: Server;
let browser: Browser;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><title>Client security fixture</title><script type="module" src="/fixture.js"></script><body><main></main></body></html>',
      );
      return;
    }
    if (pathname === '/fixture.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
      });
      response.end(
        "import {validateFragment} from '/morph.js'; import {createLiveClient} from '/index.js'; globalThis.nvSecurityFixture = {validateFragment, createLiveClient};",
      );
      return;
    }
    // Test-only static asset server: no arbitrary paths or source-tree lookup.
    if (!/^\/[a-z-]+\.js$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL(`../packages/client/dist${pathname}`, import.meta.url),
      'utf8',
    ).then(
      (source) => {
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
        });
        response.end(source);
      },
      () => {
        response.writeHead(404).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe('real-browser Live fragment trust boundaries', () => {
  it('rejects active markup and foreign namespaces before morphing', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base);
      await page.waitForFunction(() =>
        Reflect.has(globalThis, 'nvSecurityFixture'),
      );
      const result = await page.evaluate(() => {
        // This trusted fixture script imports the actual built module outside Vite's SSR transform.
        const module = Reflect.get(globalThis, 'nvSecurityFixture') as {
          validateFragment(fragment: DocumentFragment): void;
        };
        const attacks = [
          '<script>alert(1)</script>',
          '<iframe src="about:blank"></iframe>',
          '<img src="x" onerror="alert(1)">',
          '<a href="java&#10;script:alert(1)">unsafe</a>',
          '<form action="data:text/html,unsafe"></form>',
          '<svg><script href="/payload.js"></script></svg>',
          '<svg><a href="/safe"><animate attributeName="href" values="javascript:alert(1)" /></a></svg>',
          '<math><mtext>foreign namespace</mtext></math>',
        ];
        const accepted: string[] = [];
        for (const markup of attacks) {
          const template = document.createElement('template');
          template.innerHTML = markup;
          try {
            module.validateFragment(template.content);
            accepted.push(markup);
          } catch {
            /* Expected rejection. */
          }
        }
        const safe = document.createElement('template');
        safe.innerHTML =
          '<section><output>safe &lt;script&gt; text</output><input type="text"><a href="/relative">Link</a></section>';
        module.validateFragment(safe.content);
        return accepted;
      });
      expect(result).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('rejects cross-origin action endpoints before making a transport request', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base);
      await page.waitForFunction(() =>
        Reflect.has(globalThis, 'nvSecurityFixture'),
      );
      const result = await page.evaluate(async () => {
        const module = Reflect.get(globalThis, 'nvSecurityFixture') as {
          createLiveClient(options: {
            root: Document;
            fetch: typeof fetch;
            onError(error: Error): void;
          }): { mount(): void; dispose(): void };
        };
        const marker = document.createElement('div');
        for (const [key, value] of Object.entries({
          'data-nv-component': 'component',
          'data-nv-name': 'counter',
          'data-nv-snapshot': 'opaque',
          'data-nv-csrf': 'csrf',
          'data-nv-revision': '0',
          'data-nv-state': '{"count":0}',
          'data-nv-endpoint': 'https://untrusted.invalid/live',
        }))
          marker.setAttribute(key, value);
        marker.innerHTML = '<button nv:click="increment">Increase</button>';
        document.body.append(marker);
        let transports = 0;
        const errors: string[] = [];
        const client = module.createLiveClient({
          root: document,
          fetch: async () => {
            transports++;
            throw new Error('Unexpected transport');
          },
          onError: (error) => errors.push(error.message),
        });
        client.mount();
        marker.querySelector('button')?.click();
        await Promise.resolve();
        client.dispose();
        return { transports, errors };
      });
      expect(result.transports).toBe(0);
      expect(result.errors).toEqual([
        'Live endpoint must be same-origin without query, fragment or credentials',
      ]);
    } finally {
      await page.close();
    }
  });
});
