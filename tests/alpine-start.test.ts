import 'reflect-metadata';
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
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startLiveAlpine } from '../packages/alpine/dist/index.js';
import type {
  AlpineRuntime,
  LiveAlpineApplication,
  ManagedLiveClient,
} from '../packages/alpine/dist/index.js';

interface TestAlpine extends AlpineRuntime {
  data(name: string, factory: () => object): void;
}
interface StartupFixture {
  adapter: typeof import('../packages/alpine/dist/index.js');
  copy: typeof import('../packages/alpine/dist/index.js');
  client: typeof import('../packages/client/dist/index.js');
  alpine: TestAlpine;
}
interface StartupSession {
  application?: LiveAlpineApplication;
  client: ManagedLiveClient;
  counters: {
    mount: number;
    dispose: number;
    start: number;
    configure: number;
  };
  order: string[];
  requests: { updates: Record<string, unknown>; action: string }[];
  errors: string[];
}
declare global {
  interface Window {
    nvStartupFixture: StartupFixture;
    nvStartupSession: StartupSession;
  }
}
let browser: Browser;
let server: Server;
let page: Page;
let base: string;
let pageErrors: string[];
const markup =
  '<label for="draft">Name</label><input id="draft" nv:model="name" value="initial"><output id="preview" nv:text="name">initial</output><output id="server-count" nv:text="count">0</output><div nv:ignore="" x-data="localCounter"><button id="local" type="button" x-on:click="incrementLocal">Local</button><output id="local-count" x-text="clicks">0</output><button id="server" type="button" x-on:click="$live.call(\'save\')">Server</button><output id="alpine-server" x-text="$live.get(\'count\')">0</output></div>';

beforeAll(async () => {
  const require = createRequire(
    new URL('../packages/nestvexa/package.json', import.meta.url),
  );
  const alpineSource = new URL(
    './module.esm.js',
    pathToFileURL(require.resolve('@alpinejs/csp')),
  );
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; object-src 'none'",
        })
        .end(
          '<!doctype html><html lang="en"><head><title>Default Alpine startup fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as adapter from '/adapter.js'; import * as copy from '/adapter-copy.js'; import * as client from '/client/index.js'; import alpine from '/alpine.js'; window.nvStartupFixture={adapter,copy,client,alpine};",
        );
      return;
    }
    const file =
      pathname === '/alpine.js'
        ? alpineSource
        : pathname === '/adapter.js' || pathname === '/adapter-copy.js'
          ? new URL('../packages/alpine/dist/index.js', import.meta.url)
          : /^\/client\/[a-z][a-z0-9-]*\.js$/.test(pathname)
            ? new URL(
                `../packages/client/dist/${pathname.slice('/client/'.length)}`,
                import.meta.url,
              )
            : undefined;
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    void readFile(file, 'utf8').then(
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
    throw new Error('Missing startup fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  pageErrors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvStartupFixture'));
});
afterEach(async () => {
  if (page) {
    await page.evaluate(() => window.nvStartupSession?.application?.dispose());
    await page.close();
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

async function prepare(): Promise<void> {
  await page.evaluate((html) => {
    const root = document.createElement('section');
    root.id = 'widget';
    for (const [name, value] of Object.entries({
      'data-nv-component': '11111111-1111-4111-8111-111111111111',
      'data-nv-name': 'startup',
      'data-nv-snapshot': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'data-nv-revision': '0',
      'data-nv-endpoint': '/live/startup',
      'data-nv-csrf': 'startup-fixture-012345678901234567890123456789',
      'data-nv-state': JSON.stringify({ name: 'initial', count: 0 }),
    }))
      root.setAttribute(name, value);
    root.innerHTML = html;
    document.querySelector('main')?.append(root);
    const counters = { mount: 0, dispose: 0, start: 0, configure: 0 };
    const order: string[] = [];
    const requests: StartupSession['requests'] = [];
    const errors: string[] = [];
    let count = 0;
    let name: unknown = 'initial';
    const underlying = window.nvStartupFixture.client.createLiveClient({
      onError: (error) => errors.push(error.message),
      fetch: async (url, init) => {
        // The fixture consumes requests generated by this actual client, not hostile protocol input.
        const payload = JSON.parse(String(init?.body)) as {
          requestId: string;
          revision: number;
          snapshot: string;
          updates: Record<string, unknown>;
        };
        requests.push({
          updates: payload.updates,
          action: String(url).split('/').at(-1) ?? '',
        });
        name = payload.updates['name'] ?? name;
        count++;
        return new Response(
          JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: payload.requestId,
            component: {
              id: root.getAttribute('data-nv-component'),
              name: 'startup',
              revision: payload.revision + 1,
            },
            snapshot: payload.snapshot,
            state: { name, count },
            html,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const client: ManagedLiveClient = {
      call: (element, action) => underlying.call(element, action),
      get: (element, name) => underlying.get(element, name),
      set: (element, name, value) => underlying.set(element, name, value),
      mount() {
        counters.mount++;
        order.push('mount');
        underlying.mount();
      },
      dispose() {
        counters.dispose++;
        underlying.dispose();
      },
    };
    const alpine = window.nvStartupFixture.alpine;
    const original = alpine.start.bind(alpine);
    alpine.start = () => {
      counters.start++;
      order.push('start');
      original();
    };
    window.nvStartupSession = { client, counters, order, requests, errors };
  }, markup);
}
async function boot(): Promise<void> {
  await page.evaluate(() => {
    const { adapter, alpine } = window.nvStartupFixture;
    const session = window.nvStartupSession;
    session.application = adapter.startLiveAlpine(alpine, session.client, {
      configure(instance, client) {
        session.counters.configure++;
        session.order.push('configure');
        if (instance !== alpine || client !== session.client)
          throw new Error('Wrong startup context');
        alpine.data('localCounter', () => ({
          clicks: 0,
          incrementLocal(this: { clicks: number }) {
            this.clicks++;
          },
        }));
      },
    });
  });
  await page.waitForFunction(
    () => document.querySelector('#alpine-server')?.textContent === '0',
  );
}

describe('default Live/Alpine application startup', () => {
  it('is safe to import in a non-browser process without creating a document', () => {
    expect(typeof startLiveAlpine).toBe('function');
    expect(Reflect.get(globalThis, 'document')).toBeUndefined();
  });
  it('requires an attached document when called outside a browser', () => {
    // Deliberately invalid runtime objects never cross the rejected document boundary.
    expect(() =>
      startLiveAlpine({} as AlpineRuntime, {} as ManagedLiveClient),
    ).toThrow('attached browser document');
  });
  it('registers extensions, mounts Live, then starts the actual CSP Alpine exactly once', async () => {
    await prepare();
    await boot();
    expect(await page.evaluate(() => window.nvStartupSession.order)).toEqual([
      'configure',
      'mount',
      'start',
    ]);
    await page.locator('#local').click();
    expect(await page.locator('#local-count').textContent()).toBe('1');
    await page.locator('#server').click();
    await page.waitForFunction(
      () => document.querySelector('#alpine-server')?.textContent === '1',
    );
    expect(await page.locator('#server-count').textContent()).toBe('1');
    expect(await page.locator('#local-count').textContent()).toBe('1');
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 1, dispose: 0, start: 1, configure: 1 },
    );
    expect(await page.evaluate(() => window.nvStartupSession.errors)).toEqual(
      [],
    );
  });
  it('coalesces repeated startup from another adapter copy without mounting the unused client', async () => {
    await prepare();
    await boot();
    const same = await page.evaluate(() => {
      const { copy, alpine, client: clientModule } = window.nvStartupFixture;
      return (
        copy.startLiveAlpine(alpine, clientModule.createLiveClient(), {
          configure() {
            throw new Error('Duplicate configure');
          },
        }) === window.nvStartupSession.application
      );
    });
    expect(same).toBe(true);
    await page.locator('#server').click();
    await page.waitForFunction(
      () => document.querySelector('#server-count')?.textContent === '1',
    );
    expect(
      await page.evaluate(() => window.nvStartupSession.requests),
    ).toHaveLength(1);
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 1, dispose: 0, start: 1, configure: 1 },
    );
  });
  it('retains deferred drafts, local Alpine state and the same owner through persisted page transitions', async () => {
    await prepare();
    await boot();
    await page.locator('#draft').fill('unsent before BFCache');
    await page.locator('#local').click();
    const same = await page.evaluate(() => {
      const session = window.nvStartupSession;
      const prior = session.application;
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      );
      return (
        prior ===
        window.nvStartupFixture.adapter.startLiveAlpine(
          window.nvStartupFixture.alpine,
          session.client,
        )
      );
    });
    expect(same).toBe(true);
    expect(await page.locator('#draft').inputValue()).toBe(
      'unsent before BFCache',
    );
    expect(await page.locator('#local-count').textContent()).toBe('1');
    await page.locator('#server').click();
    await page.waitForFunction(
      () => document.querySelector('#server-count')?.textContent === '1',
    );
    expect(await page.evaluate(() => window.nvStartupSession.requests)).toEqual(
      [{ action: 'save', updates: { name: 'unsent before BFCache' } }],
    );
    expect(await page.locator('#local-count').textContent()).toBe('1');
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 1, dispose: 0, start: 1, configure: 1 },
    );
  });
  it('cleans up once on nonpersisted departure and refuses to restart an already initialized document', async () => {
    await prepare();
    await boot();
    const result = await page.evaluate(() => {
      const session = window.nvStartupSession;
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: false }),
      );
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: false }),
      );
      session.application?.dispose();
      try {
        window.nvStartupFixture.copy.startLiveAlpine(
          window.nvStartupFixture.alpine,
          session.client,
        );
        return 'unexpected restart';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    });
    expect(result).toContain('disposed');
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 1, dispose: 1, start: 1, configure: 1 },
    );
  });
  it('rejects a second Alpine owner without touching its startup', async () => {
    await prepare();
    await boot();
    const error = await page.evaluate(() => {
      const { adapter, alpine } = window.nvStartupFixture;
      const other = {
        ...alpine,
        start() {
          throw new Error('Foreign start');
        },
      };
      try {
        adapter.startLiveAlpine(other, window.nvStartupSession.client);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    });
    expect(error).toContain('another Alpine runtime');
    expect(
      await page.evaluate(() => window.nvStartupSession.counters.start),
    ).toBe(1);
  });
  it('rejects host-owned Alpine without invoking an accessor or mutating the host', async () => {
    await prepare();
    const result = await page.evaluate(() => {
      let reads = 0;
      Object.defineProperty(window, 'Alpine', {
        configurable: true,
        get() {
          reads++;
          return window.nvStartupFixture.alpine;
        },
      });
      try {
        window.nvStartupFixture.adapter.startLiveAlpine(
          window.nvStartupFixture.alpine,
          window.nvStartupSession.client,
        );
        return { error: '', reads };
      } catch (error) {
        return { error: error instanceof Error ? error.message : '', reads };
      } finally {
        Reflect.deleteProperty(window, 'Alpine');
      }
    });
    expect(result.reads).toBe(0);
    expect(result.error).toContain('host already owns Alpine');
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 0, dispose: 0, start: 0, configure: 0 },
    );
  });
  it.each(['start', 'mount', 'dispose', 'configure'] as const)(
    'rejects an incomplete %s lifecycle before claiming the document',
    async (missing) => {
      await prepare();
      const result = await page.evaluate((missing) => {
        const { adapter, alpine } = window.nvStartupFixture;
        const session = window.nvStartupSession;
        // Deliberately malformed host configuration exercises runtime API validation.
        const selectedAlpine =
          missing === 'start' ? { ...alpine, start: null } : alpine;
        const selectedClient = ['mount', 'dispose'].includes(missing)
          ? { ...session.client, [missing]: null }
          : session.client;
        try {
          adapter.startLiveAlpine(
            selectedAlpine as AlpineRuntime,
            selectedClient as ManagedLiveClient,
            missing === 'configure'
              ? ({ configure: null } as unknown as Parameters<
                  typeof adapter.startLiveAlpine
                >[2])
              : {},
          );
          return { message: '', claimed: true };
        } catch (error) {
          return {
            message: error instanceof Error ? error.message : '',
            claimed: Object.hasOwn(
              document,
              Symbol.for('nestvexa.alpine.application/1'),
            ),
          };
        }
      }, missing);
      expect(result.message).toContain('complete lifecycle APIs');
      expect(result.claimed).toBe(false);
      expect(
        await page.evaluate(() => window.nvStartupSession.counters),
      ).toEqual({ mount: 0, dispose: 0, start: 0, configure: 0 });
    },
  );
  it.each(['record', 'contract', 'application', 'dispose'] as const)(
    'rejects an incompatible %s bootstrap accessor without invoking it',
    async (field) => {
      await prepare();
      const result = await page.evaluate((field) => {
        const { adapter, alpine } = window.nvStartupFixture;
        const session = window.nvStartupSession;
        let reads = 0;
        const get = () => {
          reads++;
          throw new Error('Foreign getter must not execute');
        };
        const application = { alpine, client: session.client, dispose() {} };
        const record = {
          contract: 'nestvexa.alpine.application/1',
          status: 'active',
          application,
        };
        if (field === 'dispose')
          Object.defineProperty(application, 'dispose', { get });
        else if (field !== 'record')
          Object.defineProperty(record, field, { get });
        Object.defineProperty(
          document,
          Symbol.for('nestvexa.alpine.application/1'),
          field === 'record' ? { get } : { value: record },
        );
        try {
          adapter.startLiveAlpine(alpine, session.client);
          return { message: '', reads };
        } catch (error) {
          return {
            message: error instanceof Error ? error.message : '',
            reads,
          };
        }
      }, field);
      expect(result.message).toContain('incompatible');
      expect(result.reads).toBe(0);
      expect(
        await page.evaluate(() => window.nvStartupSession.counters),
      ).toEqual({ mount: 0, dispose: 0, start: 0, configure: 0 });
    },
  );
  it('reports both startup and cleanup failures while leaving the failed document nonrestartable', async () => {
    await prepare();
    const result = await page.evaluate(() => {
      const { adapter, alpine } = window.nvStartupFixture;
      const session = window.nvStartupSession;
      session.client.dispose = () => {
        session.counters.dispose++;
        throw new Error('cleanup failed');
      };
      let errors: string[] = [];
      let retry = '';
      try {
        adapter.startLiveAlpine(alpine, session.client, {
          configure() {
            throw new Error('configuration failed');
          },
        });
      } catch (error) {
        if (error instanceof AggregateError)
          errors = error.errors.map((failure: unknown) =>
            failure instanceof Error ? failure.message : '',
          );
      }
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: false }),
      );
      try {
        adapter.startLiveAlpine(alpine, session.client);
      } catch (error) {
        retry = error instanceof Error ? error.message : '';
      }
      return { errors, retry, cleanups: session.counters.dispose };
    });
    expect(result.errors).toEqual(['configuration failed', 'cleanup failed']);
    expect(result.retry).toContain('failed');
    expect(result.cleanups).toBe(1);
  });
  it.each(['configure', 'mount', 'start'] as const)(
    'cleans failed %s startup and refuses an unsafe retry',
    async (failure) => {
      await prepare();
      const result = await page.evaluate((failure) => {
        const { adapter, copy, alpine } = window.nvStartupFixture;
        const session = window.nvStartupSession;
        if (failure === 'mount')
          session.client.mount = () => {
            session.counters.mount++;
            throw new Error('mount failed');
          };
        if (failure === 'start')
          alpine.start = () => {
            session.counters.start++;
            throw new Error('start failed');
          };
        let first = '';
        let retry = '';
        try {
          adapter.startLiveAlpine(alpine, session.client, {
            configure() {
              if (failure === 'configure') throw new Error('configure failed');
            },
          });
        } catch (error) {
          first = error instanceof Error ? error.message : '';
        }
        window.dispatchEvent(
          new PageTransitionEvent('pagehide', { persisted: false }),
        );
        try {
          copy.startLiveAlpine(alpine, session.client);
        } catch (error) {
          retry = error instanceof Error ? error.message : '';
        }
        return { first, retry, counters: session.counters };
      }, failure);
      expect(result.first).toBe(`${failure} failed`);
      expect(result.retry).toContain('failed');
      expect(result.counters.dispose).toBe(1);
      expect(result.counters.start).toBe(failure === 'start' ? 1 : 0);
    },
  );
  it('rejects reentrant startup during configuration and cleans the original attempt', async () => {
    await prepare();
    const error = await page.evaluate(() => {
      const { adapter, copy, alpine } = window.nvStartupFixture;
      const session = window.nvStartupSession;
      try {
        adapter.startLiveAlpine(alpine, session.client, {
          configure() {
            copy.startLiveAlpine(alpine, session.client);
          },
        });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    });
    expect(error).toContain('starting');
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 0, dispose: 1, start: 0, configure: 0 },
    );
  });
});

describe('adopting a host-owned Alpine (default distribution with page Alpine)', () => {
  async function adopt(): Promise<string> {
    return page.evaluate(() => {
      const { adapter, alpine } = window.nvStartupFixture;
      const session = window.nvStartupSession;
      try {
        adapter.adoptLiveAlpine(alpine, session.client, {
          configure() {
            session.counters.configure++;
            session.order.push('configure');
            alpine.data('localCounter', () => ({
              clicks: 0,
              incrementLocal(this: { clicks: number }) {
                this.clicks++;
              },
            }));
          },
        });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    });
  }
  it('registers $live and mounts Live without starting Alpine; the host starts it', async () => {
    await prepare();
    expect(await adopt()).toBe('');
    expect(await page.evaluate(() => window.nvStartupSession.order)).toEqual([
      'configure',
      'mount',
    ]);
    // The page keeps its lifecycle and starts Alpine itself.
    await page.evaluate(() => window.nvStartupFixture.alpine.start());
    await page.waitForFunction(
      () => document.querySelector('#alpine-server')?.textContent === '0',
    );
    await page.locator('#server').click();
    await page.waitForFunction(
      () => document.querySelector('#alpine-server')?.textContent === '1',
    );
    expect(await page.evaluate(() => window.nvStartupSession.counters)).toEqual(
      { mount: 1, dispose: 0, start: 1, configure: 1 },
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: false }),
      ),
    );
    expect(
      await page.evaluate(() => window.nvStartupSession.counters.dispose),
    ).toBe(1);
  });
  it('reads window.Alpine only as a data property, never through an accessor', async () => {
    await prepare();
    const result = await page.evaluate(() => {
      const { adapter, alpine } = window.nvStartupFixture;
      let reads = 0;
      Object.defineProperty(window, 'Alpine', {
        configurable: true,
        get() {
          reads++;
          return alpine;
        },
      });
      const viaAccessor = adapter.hostAlpine() === undefined;
      Object.defineProperty(window, 'Alpine', {
        configurable: true,
        writable: true,
        value: alpine,
      });
      const viaData = adapter.hostAlpine() === alpine;
      Reflect.deleteProperty(window, 'Alpine');
      return {
        viaAccessor,
        viaData,
        reads,
        none: adapter.hostAlpine() === undefined,
      };
    });
    expect(result).toEqual({
      viaAccessor: true,
      viaData: true,
      reads: 0,
      none: true,
    });
  });
  it('rejects an incompatible host Alpine version before mounting and fails closed', async () => {
    await prepare();
    const result = await page.evaluate(() => {
      const { adapter, alpine } = window.nvStartupFixture;
      const session = window.nvStartupSession;
      const old = {
        version: '3.13.0',
        magic: alpine.magic.bind(alpine),
        reactive: alpine.reactive.bind(alpine),
      };
      let first = '';
      let retry = '';
      try {
        adapter.adoptLiveAlpine(old, session.client);
      } catch (error) {
        first = error instanceof Error ? error.message : '';
      }
      try {
        adapter.adoptLiveAlpine(alpine, session.client);
      } catch (error) {
        retry = error instanceof Error ? error.message : '';
      }
      return { first, retry, counters: session.counters };
    });
    expect(result.first).toContain('3.17.x');
    expect(result.retry).toContain('failed');
    expect(result.counters).toEqual({
      mount: 0,
      dispose: 1,
      start: 0,
      configure: 0,
    });
  });
  it('coalesces adoption after the default start with the same Alpine', async () => {
    await prepare();
    await boot();
    const coalesced = await page.evaluate(() => {
      const { copy, alpine } = window.nvStartupFixture;
      return (
        copy.adoptLiveAlpine(alpine, window.nvStartupSession.client) ===
        window.nvStartupSession.application
      );
    });
    expect(coalesced).toBe(true);
  });
  it('refuses to start an Alpine whose lifecycle the host owns', async () => {
    await prepare();
    expect(await adopt()).toBe('');
    const refused = await page.evaluate(() => {
      const { copy, alpine } = window.nvStartupFixture;
      try {
        copy.startLiveAlpine(alpine, window.nvStartupSession.client);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    });
    expect(refused).toContain('host owns this Alpine lifecycle');
    expect(
      await page.evaluate(() => window.nvStartupSession.counters.start),
    ).toBe(0);
  });
});
