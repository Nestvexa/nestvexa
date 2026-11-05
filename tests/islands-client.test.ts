import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Browser-level tests of the island loader (`@nestvexa/islands/client`) in
 * real Chromium: mount strategies, allowlist refusal, manifest enforcement,
 * the event bridge, unmount races, hydration reporting and shared context.
 */
declare global {
  interface Window {
    nvIslandsClient: typeof import('../packages/islands/dist/client.js');
    harness: {
      log: string[];
      errors: string[];
      mismatches: string[];
      loader?: import('../packages/islands/dist/client.js').IslandsLoader;
      gates: Record<string, () => void>;
    };
  }
}

let browser: Browser;
let bundle = '';
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  const result = await build({
    entryPoints: ['packages/islands/dist/client.js'],
    bundle: true,
    format: 'iife',
    globalName: 'nvIslandsClient',
    write: false,
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]?.text ?? '';
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
});

async function setup(html: string): Promise<void> {
  await page.setContent(`<!doctype html><body>${html}</body>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    window.harness = { log: [], errors: [], mismatches: [], gates: {} };
  });
}
const log = () => page.evaluate(() => window.harness.log);
const island = (id: string, extra = '', props = '{}') =>
  `<div data-nv-island="${id}" data-nv-framework="custom" ${extra} data-nv-props='${props}'>fallback</div>`;

describe('island loader strategies and allowlist', () => {
  it('mounts interaction islands only on first interaction, exactly once', async () => {
    await setup(
      `${island('lazy', 'data-nv-mount="interaction"')}<button id="other">x</button>`,
    );
    await page.evaluate(() => {
      const { createIslands } = window.nvIslandsClient;
      window.harness.loader = createIslands({
        modules: {
          lazy: async () => (element) => {
            window.harness.log.push('mount');
            element.textContent = 'mounted';
            return () => window.harness.log.push('unmount');
          },
        },
      });
      window.harness.loader.start();
    });
    await page.waitForTimeout(100);
    expect(await log()).toEqual([]);
    await page.click('#other');
    expect(await log()).toEqual([]);
    await page.hover('[data-nv-island=lazy]');
    await expect.poll(log).toEqual(['mount']);
    await page.click('[data-nv-island=lazy]');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(50);
    expect(await log()).toEqual(['mount']);
    expect(await page.textContent('[data-nv-island=lazy]')).toBe('mounted');
  });

  it('starts interaction islands from keyboard focus too', async () => {
    await setup(
      `<div data-nv-island="keys" data-nv-framework="custom" data-nv-mount="interaction" data-nv-props="{}"><button>Open</button></div>`,
    );
    await page.evaluate(() => {
      window.harness.loader = window.nvIslandsClient.createIslands({
        modules: {
          keys: async () => () => {
            window.harness.log.push('mount');
            return () => undefined;
          },
        },
      });
      window.harness.loader.start();
    });
    await page.keyboard.press('Tab');
    await expect.poll(log).toEqual(['mount']);
  });

  it('refuses ids outside the build-time allowlist without loading anything', async () => {
    await setup(
      `${island('known', 'data-nv-mount="immediate"')}${island('../../etc/passwd', 'data-nv-mount="immediate"')}${island('constructor', 'data-nv-mount="immediate"')}${island('unlisted', 'data-nv-mount="immediate"')}`,
    );
    await page.evaluate(() => {
      const loaded: string[] = [];
      window.harness.loader = window.nvIslandsClient.createIslands({
        modules: {
          known: async () => {
            loaded.push('known');
            return () => () => undefined;
          },
        },
        onError: (error) => window.harness.errors.push(String(error)),
      });
      window.harness.loader.start();
      window.harness.log = loaded;
    });
    await expect.poll(log).toEqual(['known']);
    const errors = await page.evaluate(() => window.harness.errors);
    expect(errors).toHaveLength(3);
    for (const error of errors)
      expect(error).toMatch(/not in the client allowlist/);
    expect(await page.locator('[data-nv-island-error]').count()).toBe(3);
    expect(await page.locator('[data-nv-island=unlisted]').textContent()).toBe(
      'fallback',
    );
  });

  it('enforces the manifest: ids, framework, size, schema and bundle path', async () => {
    const manifest = {
      version: 1,
      islands: {
        chart: {
          framework: 'react',
          strategy: 'immediate',
          bundle: '/islands/chart-ABC.js',
          maxPropsBytes: 40,
          props: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 10 } },
          },
        },
      },
    };
    await setup(
      [
        `<div data-nv-island="chart" data-nv-framework="react" data-nv-mount="immediate" data-nv-bundle="/evil.js" data-nv-props='{"title":"Sales"}' id="ok"></div>`,
        `<div data-nv-island="chart" data-nv-framework="vue" data-nv-mount="immediate" data-nv-props='{}' id="framework"></div>`,
        `<div data-nv-island="chart" data-nv-framework="react" data-nv-mount="immediate" data-nv-props='{"title":"${'x'.repeat(50)}"}' id="size"></div>`,
        `<div data-nv-island="chart" data-nv-framework="react" data-nv-mount="immediate" data-nv-props='{"secret":"x"}' id="schema"></div>`,
        `<div data-nv-island="other" data-nv-framework="react" data-nv-mount="immediate" data-nv-props='{}' id="unknown"></div>`,
      ].join(''),
    );
    await page.evaluate((value) => {
      window.harness.loader = window.nvIslandsClient.createIslands({
        manifest: value as never,
        importModule: async (path) => {
          window.harness.log.push(path);
          return {
            default: (element: HTMLElement) => {
              element.textContent = 'mounted';
              return () => undefined;
            },
          };
        },
        onError: (error, element) =>
          window.harness.errors.push(`${element.id}: ${String(error)}`),
      });
      window.harness.loader.start();
    }, manifest);
    await expect.poll(() => page.textContent('#ok')).toBe('mounted');
    // Only the manifest path is ever imported; markup attributes are ignored.
    expect(await log()).toEqual(['/islands/chart-ABC.js']);
    const errors = (await page.evaluate(() => window.harness.errors)).sort();
    expect(errors).toEqual([
      expect.stringMatching(/^framework: .*does not match the manifest/),
      expect.stringMatching(/^schema: .*secret is not a declared prop/),
      expect.stringMatching(/^size: .*exceed the manifest limit/),
      expect.stringMatching(/^unknown: .*not in the client allowlist/),
    ]);
    await expect(
      page.evaluate(() =>
        window.nvIslandsClient.createIslands({
          manifest: {
            version: 1,
            islands: {
              x: {
                framework: 'react',
                strategy: 'idle',
                bundle: 'https://cdn.example/x.js',
                maxPropsBytes: 10,
              },
            },
          },
        }),
      ),
    ).rejects.toThrow(/Invalid island manifest entry/);
  });
});

describe('island event bridge', () => {
  it('caps listeners, validates names and payloads, clones details and cleans up on unmount', async () => {
    await setup(
      `${island('sender', 'data-nv-mount="immediate"')}${island('receiver', 'data-nv-mount="immediate"')}`,
    );
    const result = await page.evaluate(async () => {
      const outcomes: Record<string, unknown> = {};
      const received: unknown[] = [];
      let sender:
        import('../packages/islands/dist/client.js').IslandContext | undefined;
      const loader = window.nvIslandsClient.createIslands({
        maxListeners: 4,
        modules: {
          sender: async () => (_element, _props, context) => {
            sender = context;
            return () => undefined;
          },
          receiver: async () => (_element, _props, context) => {
            context.on(
              'cart.updated',
              (detail) => received.push(detail),
              (detail) =>
                typeof detail === 'object' &&
                detail !== null &&
                'count' in detail,
            );
            const early = context.on('cart.updated', () =>
              received.push('early'),
            );
            early();
            context.on('a', () => undefined);
            context.on('b', () => undefined);
            context.on('c', () => undefined);
            try {
              context.on('d', () => undefined);
            } catch (error) {
              outcomes['cap'] = String(error);
            }
            try {
              context.on('Bad Name!', () => undefined);
            } catch (error) {
              outcomes['name'] = String(error);
            }
            return () => undefined;
          },
        },
      });
      window.harness.loader = loader;
      loader.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const payload = { count: 1, nested: { items: ['a'] } };
      sender?.emit('cart.updated', payload);
      payload.nested.items.push('mutated-after-emit');
      sender?.emit('cart.updated', { unexpected: true });
      try {
        sender?.emit('cart.updated', { fn: () => 1 });
      } catch (error) {
        outcomes['clone'] = (error as Error).name;
      }
      try {
        sender?.emit('../x');
      } catch (error) {
        outcomes['emitName'] = String(error);
      }
      outcomes['before'] = loader
        .diagnostics()
        .map((entry) => [entry.id, entry.listeners, entry.rejectedEvents]);
      document.querySelector('[data-nv-island=receiver]')?.remove();
      await new Promise((resolve) => setTimeout(resolve, 20));
      sender?.emit('cart.updated', { count: 2 });
      outcomes['after'] = loader
        .diagnostics()
        .map((entry) => [entry.id, entry.listeners]);
      outcomes['received'] = received;
      return outcomes;
    });
    expect(result['cap']).toMatch(/Too many island listeners/);
    expect(result['name']).toMatch(/Invalid island event name/);
    expect(result['emitName']).toMatch(/Invalid island event name/);
    expect(result['clone']).toBe('DataCloneError');
    expect(result['before']).toEqual([
      ['sender', 0, 0],
      ['receiver', 4, 1],
    ]);
    // The receiver saw a detached copy, never the later mutation, and no
    // events after it was removed.
    expect(result['received']).toEqual([
      { count: 1, nested: { items: ['a'] } },
    ]);
    expect(result['after']).toEqual([['sender', 0]]);
  });
});

describe('island lifecycle races and navigation', () => {
  it('never mounts an island removed while its chunk is still loading', async () => {
    await setup(island('slow', 'data-nv-mount="immediate"'));
    await page.evaluate(() => {
      window.harness.loader = window.nvIslandsClient.createIslands({
        modules: {
          slow: () =>
            new Promise((resolve) => {
              window.harness.gates['slow'] = () =>
                resolve(() => {
                  window.harness.log.push('mount');
                  return () => window.harness.log.push('unmount');
                });
            }),
        },
        onError: (error) => window.harness.errors.push(String(error)),
      });
      window.harness.loader.start();
    });
    await expect
      .poll(() => page.evaluate(() => typeof window.harness.gates['slow']))
      .toBe('function');
    expect(await page.getAttribute('[data-nv-island=slow]', 'aria-busy')).toBe(
      'true',
    );
    await page.evaluate(() => {
      document.querySelector('[data-nv-island=slow]')?.remove();
    });
    await page.waitForTimeout(20);
    await page.evaluate(() => window.harness.gates['slow']?.());
    await page.waitForTimeout(50);
    expect(await log()).toEqual([]);
    expect(await page.evaluate(() => window.harness.errors)).toEqual([]);
    expect(await page.evaluate(() => window.harness.loader?.mounted)).toBe(0);
  });

  it('unmounts immediately when removal races an asynchronous mount', async () => {
    await setup(island('async', 'data-nv-mount="immediate"'));
    await page.evaluate(() => {
      window.harness.loader = window.nvIslandsClient.createIslands({
        modules: {
          async: async () => async () => {
            window.harness.log.push('mount:start');
            await new Promise<void>((resolve) => {
              window.harness.gates['mount'] = resolve;
            });
            window.harness.log.push('mount:end');
            return () => window.harness.log.push('unmount');
          },
        },
      });
      window.harness.loader.start();
    });
    await expect.poll(log).toEqual(['mount:start']);
    await page.evaluate(() =>
      document.querySelector('[data-nv-island=async]')?.remove(),
    );
    await page.waitForTimeout(20);
    await page.evaluate(() => window.harness.gates['mount']?.());
    await expect.poll(log).toEqual(['mount:start', 'mount:end', 'unmount']);
  });

  it('runs island cleanup on pagehide but keeps islands for back/forward cache', async () => {
    await setup(island('page', 'data-nv-mount="immediate"'));
    await page.evaluate(() => {
      window.harness.loader = window.nvIslandsClient.createIslands({
        modules: {
          page: async () => () => {
            window.harness.log.push('mount');
            return () => window.harness.log.push('unmount');
          },
        },
      });
      window.harness.loader.start();
    });
    await expect.poll(log).toEqual(['mount']);
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: true }),
      ),
    );
    expect(await log()).toEqual(['mount']);
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: false }),
      ),
    );
    expect(await log()).toEqual(['mount', 'unmount']);
  });
});

describe('island hydration, context and services', () => {
  it('reports hydration mismatches only for server-rendered roots', async () => {
    await setup(
      `${island('ssr', 'data-nv-mount="immediate" data-nv-ssr=""')}${island('csr', 'data-nv-mount="immediate"')}`,
    );
    const diagnostics = await page.evaluate(async () => {
      const mount: import('../packages/islands/dist/client.js').IslandMount = (
        _element,
        _props,
        context,
      ) => {
        window.harness.log.push(`${context.id}:${String(context.hydrate)}`);
        for (let index = 0; index < 15; index++)
          context.reportMismatch(`text differs ${index}`);
        return () => undefined;
      };
      const loader = window.nvIslandsClient.createIslands({
        modules: { ssr: async () => mount, csr: async () => mount },
        onHydrationMismatch: (element, mismatch) =>
          window.harness.mismatches.push(
            `${element.getAttribute('data-nv-island')}:${mismatch.detail}`,
          ),
      });
      loader.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return loader.diagnostics().map((entry) => [entry.id, entry.hydration]);
    });
    expect((await log()).sort()).toEqual(['csr:false', 'ssr:true']);
    expect(diagnostics).toEqual([
      ['ssr', 'mismatch'],
      ['csr', 'none'],
    ]);
    const mismatches = await page.evaluate(() => window.harness.mismatches);
    // Bounded reporting: at most 10 callbacks per island.
    expect(mismatches).toHaveLength(10);
    expect(mismatches[0]).toBe('ssr:text differs 0');
    expect(
      await page.getAttribute(
        '[data-nv-island=ssr]',
        'data-nv-hydration-mismatch',
      ),
    ).toBe('');
    expect(
      await page.getAttribute(
        '[data-nv-island=csr]',
        'data-nv-hydration-mismatch',
      ),
    ).toBeNull();
  });

  it('passes theme tokens, page context, services and signed props', async () => {
    await setup(
      `<script type="application/json" id="nv-islands-context">{"locale":"ar","direction":"rtl","theme":{"brand":"#123456"},"user":{"name":"Ada"}}</script>${island('themed', 'data-nv-mount="immediate" data-nv-props-token="v1.1.2.sig"', '{"a":1}')}`,
    );
    const seen = await page.evaluate(async () => {
      let captured: Record<string, unknown> = {};
      const loader = window.nvIslandsClient.createIslands({
        services: { actions: { ping: () => 'pong' } },
        modules: {
          themed: async () => (element, props, context) => {
            const services = context.services as {
              actions: { ping: () => string };
            };
            captured = {
              props,
              shared: context.shared,
              ping: services.actions.ping(),
              signed: context.signed,
              token: getComputedStyle(element).getPropertyValue('--nv-brand'),
              dir: element.getAttribute('dir'),
              lang: element.getAttribute('lang'),
            };
            return () => undefined;
          },
        },
      });
      loader.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return captured;
    });
    expect(seen).toEqual({
      props: { a: 1 },
      shared: {
        locale: 'ar',
        direction: 'rtl',
        theme: { brand: '#123456' },
        user: { name: 'Ada' },
      },
      ping: 'pong',
      signed: { props: '{"a":1}', token: 'v1.1.2.sig' },
      token: '#123456',
      dir: 'rtl',
      lang: 'ar',
    });
  });

  it('rejects an unsafe page context instead of applying it', async () => {
    await setup(
      `<script type="application/json" id="nv-islands-context">{"theme":{"brand":"red;}body{display:none"}}</script>`,
    );
    await expect(
      page.evaluate(() =>
        window.nvIslandsClient.createIslands({ modules: {} }),
      ),
    ).rejects.toThrow(/Invalid island theme token/);
  });
});
