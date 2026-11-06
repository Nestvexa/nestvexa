import 'reflect-metadata';
import AxeBuilder from '@axe-core/playwright';
import { chromium, firefox, webkit } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import {
  DevtoolsInspector,
  DevtoolsModule,
  MemoryInstrumentation,
  requestTracingMiddleware,
} from '../packages/observability/dist/index.js';

// Firefox and WebKit start slowly on loaded CI hosts.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

declare global {
  interface Window {
    nvViolations: string[];
  }
}

// Chromium by default; NV_UI_BROWSERS=chromium,firefox,webkit runs every engine.
const engines = { chromium, firefox, webkit } as const;
const selected = (process.env['NV_UI_BROWSERS'] ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is keyof typeof engines => name in engines);
// Assigned port for this suite (devtools range 3486-3492).
const port = 3486;
const origin = `http://127.0.0.1:${port}`;
const csrf = 'devtools-browser-csrf-0123456789012345678';

@LiveComponent({ name: 'cart', view: 'cart' })
class Cart {
  @State() items = 0;
  @State() sessionToken = 'browser-secret-session-token';
  @State() errors: Record<string, string> = {};
  @Action() add(): void {
    this.items++;
    this.errors = { quantity: 'Only 3 items allowed' };
  }
}
@Controller('shop')
class ShopController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  async page(@Req() request: object): Promise<string> {
    return (await this.live.mount(Cart, request)).value;
  }
}

let app: INestApplication;
let renderer: HbsEngine;
let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nestvexa-devtools-browser-'));
  await writeFile(join(root, 'cart.hbs'), '<p>{{items}} items</p>');
  renderer = new HbsEngine({ root });
  await renderer.initialize();
  const memory = new MemoryInstrumentation();
  const inspector = new DevtoolsInspector({ environment: 'test' });
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [Cart],
        renderer,
        origin,
        resolveIdentity: () => ({
          binding: 'session:browser-private-binding',
          csrfToken: csrf,
        }),
        authorize: () => true,
        instrumentation: memory,
        inspector,
      }),
      DevtoolsModule.register({
        instrumentation: memory,
        inspector,
        authorize: () => true,
        environment: 'development',
      }),
    ],
    controllers: [ShopController],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(requestTracingMiddleware(memory));
  await app.listen(port, '127.0.0.1');
  const html = await (await fetch(`${origin}/shop`)).text();
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  const action = await fetch(`${origin}/_nestvexa/live/cart/add`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-nestvexa-csrf': csrf,
    },
    body: JSON.stringify({
      protocol: 'nestvexa-live/1',
      requestId: randomUUID(),
      snapshot,
      revision: 0,
      updates: {},
      input: null,
    }),
  });
  expect(action.status).toBe(201);
}, 60_000);
afterAll(async () => {
  await app?.close();
  await renderer?.dispose();
  await rm(root, { recursive: true, force: true });
});

describe.each(selected)('devtools panel in %s', (engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  beforeAll(async () => {
    browser = await engines[engine].launch();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    // Init scripts are injected by the browser driver, outside the page CSP.
    await page.addInitScript(() => {
      window.nvViolations = [];
      document.addEventListener('securitypolicyviolation', (event) =>
        window.nvViolations.push(event.violatedDirective),
      );
    });
  });
  afterEach(async () => {
    expect(await page.evaluate(() => window.nvViolations)).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('lists the mounted component, its action and spans under a strict CSP', async () => {
    const response = await page.goto(`${origin}/_nestvexa/devtools`);
    expect(response?.headers()['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(
      await page.locator('#components tbody th').first().textContent(),
    ).toBe('cart');
    const renders = page.locator('#renders li');
    expect(await renders.first().locator('h3').textContent()).toContain('cart');
    expect(await renders.first().textContent()).toContain(
      'Re-render cause: action add',
    );
    expect(await renders.first().textContent()).toContain(
      'Only 3 items allowed',
    );
    await renders.first().locator('summary').click();
    const state = await renders.first().locator('pre').textContent();
    expect(state).toContain('"sessionToken": "[redacted]"');
    expect(state).not.toContain('browser-secret-session-token');
    const action = page.locator('#actions tbody tr').first();
    expect(await action.locator('td').nth(1).textContent()).toBe(
      'nestvexa.live.action',
    );
    expect(await action.locator('td').nth(3).textContent()).toBe('add');
    expect(await page.locator('#timings tbody th').allTextContents()).toEqual(
      expect.arrayContaining([
        'nestvexa.live.action',
        'nestvexa.live.render',
        'nestvexa.request',
      ]),
    );
    // The external stylesheet applied (no inline styles are allowed).
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('table') as Element)
            .borderCollapse,
      ),
    ).toBe('collapse');
    expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  });

  // axe over the full panel takes over a minute in Firefox/WebKit on loaded hosts.
  it(
    'has no axe violations in light and dark color schemes',
    { timeout: 300_000 },
    async () => {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.goto(`${origin}/_nestvexa/devtools`);
        expect(
          (await new AxeBuilder({ page }).analyze()).violations.map(
            (violation) => violation.id,
          ),
        ).toEqual([]);
      }
    },
  );

  it('navigates sections by keyboard', async () => {
    await page.goto(`${origin}/_nestvexa/devtools`);
    const focused = () =>
      page.evaluate(() => document.activeElement?.textContent ?? '');
    // Playwright's WebKit follows Safari's default of not tabbing to links,
    // so there the link is focused directly and only activation is keyboard.
    if (engine === 'webkit')
      await page.getByRole('link', { name: 'Components' }).focus();
    else
      for (let step = 0; step < 6 && (await focused()) !== 'Components'; step++)
        await page.keyboard.press('Tab');
    expect(await focused()).toBe('Components');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => location.hash)).toBe('#components');
  });
});
