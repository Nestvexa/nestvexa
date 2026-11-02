import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';

declare global {
  interface Window {
    nvOffline: typeof import('../packages/offline/dist/index.js');
    nvViolations: string[];
  }
}

/** Real Chromium against a strict-CSP fixture server serving the built browser module. */
export interface OfflineFixture {
  readonly base: string;
  readonly browser: Browser;
  page(context?: BrowserContext): Promise<Page>;
  close(): Promise<void>;
}
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'";

export async function startOfflineFixture(
  body: string,
  routes: Readonly<
    Record<string, { status: number; type: string; body: string }>
  > = {},
): Promise<OfflineFixture> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': csp,
        })
        .end(
          `<!doctype html><html lang="en"><head><title>Offline fixture</title><script type="module" src="/fixture.js"></script></head><body><main>${body}</main></body></html>`,
        );
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          "window.nvViolations=[];document.addEventListener('securitypolicyviolation',(e)=>window.nvViolations.push(e.violatedDirective));import * as offline from '/offline.js'; window.nvOffline=offline;",
        );
      return;
    }
    if (path === '/offline.js') {
      void readFile(
        new URL('../packages/offline/dist/index.js', import.meta.url),
        'utf8',
      ).then(
        (source) =>
          response
            .writeHead(200, { 'content-type': 'text/javascript' })
            .end(source),
        () => response.writeHead(500).end(),
      );
      return;
    }
    const route = routes[path];
    if (route) {
      response
        .writeHead(route.status, { 'content-type': route.type })
        .end(route.body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  return {
    base,
    browser,
    async page(context) {
      const page = await (context ?? browser).newPage();
      await page.goto(base);
      await page.waitForFunction(() => Reflect.has(window, 'nvOffline'));
      return page;
    },
    async close() {
      await browser.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
