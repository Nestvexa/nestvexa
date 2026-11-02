import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as pw } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

// Real browser interactions on shared CI hosts can exceed the default 15s.
vi.setConfig({ testTimeout: 45_000 });
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { uiHelpers } from '../packages/ui/dist/index.js';

declare global {
  interface Window {
    nvUi: typeof import('../packages/ui/dist/browser/index.js');
    nvController: import('../packages/ui/dist/browser/index.js').UiController;
    nvViolations: string[];
  }
}

const fixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>UI kit fixture</title>
    <link rel="stylesheet" href="/theme.css" />
    <script type="module" src="/fixture.js"></script>
  </head>
  <body>
    <main>
      <h1>UI kit fixture</h1>
      <button type="button" id="outside">Outside</button>
      {{uiDialogTrigger "edit" label="Edit product"}}
      {{#uiDialog id="edit" title="Edit product" closeLabel="Close" closeOn="product-created"}}
        <label for="dialog-name">Name</label>
        <input id="dialog-name" />
        <button type="button" id="dialog-save">Save</button>
      {{/uiDialog}}
      {{#uiTabs id="ltr" label="Sections"}}
        {{#uiTab id="a" label="Alpha"}}<p>Alpha panel</p>{{/uiTab}}
        {{#uiTab id="b" label="Beta"}}<p>Beta panel</p>{{/uiTab}}
        {{#uiTab id="c" label="Gamma"}}<p>Gamma panel</p>{{/uiTab}}
      {{/uiTabs}}
      <div dir="rtl" lang="ar">
        {{#uiTabs id="rtl" label="أقسام"}}
          {{#uiTab id="a" label="الأول"}}<p>الأول</p>{{/uiTab}}
          {{#uiTab id="b" label="الثاني"}}<p>الثاني</p>{{/uiTab}}
          {{#uiTab id="c" label="الثالث"}}<p>الثالث</p>{{/uiTab}}
        {{/uiTabs}}
      </div>
      <form id="form">
        {{uiCombobox id="category" name="category" label="Category" options=options emptyLabel="No matches" countLabel="{count} results"}}
      </form>
      <div id="slot"></div>
      <template id="late">
        {{#uiTabs id="late" label="Late"}}
          {{#uiTab id="x" label="Ex"}}<p>Ex panel</p>{{/uiTab}}
          {{#uiTab id="y" label="Why"}}<p>Why panel</p>{{/uiTab}}
        {{/uiTabs}}
      </template>
    </main>
    {{uiToastRegion id="toasts" label="Notifications" dismissLabel="Dismiss"}}
  </body>
</html>`;

let browser: Browser;
let page: Page;
let context: BrowserContext;
let server: Server;
let base: string;
let views: string;
let errors: string[];
beforeAll(async () => {
  views = await mkdtemp(join(tmpdir(), 'nestvexa-ui-browser-'));
  await writeFile(join(views, 'fixture.hbs'), fixture);
  const engine = new HbsEngine({ root: views });
  engine.registerHelpers(uiHelpers());
  await engine.initialize();
  const html = await engine.render('fixture', {
    options: [
      { value: 'books', label: 'Books' },
      { value: 'tools', label: 'Tools' },
      { value: 'garden', label: 'Garden' },
      { value: 'toys', label: 'Toys' },
    ],
  });
  const module = await readFile('packages/ui/dist/browser/index.js', 'utf8');
  const theme = await readFile('packages/ui/theme/theme.css', 'utf8');
  const security = {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'",
  };
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const send = (type: string, body: string) =>
      response.writeHead(200, { 'content-type': type, ...security }).end(body);
    if (path === '/') send('text/html; charset=utf-8', html);
    else if (path === '/ui.js') send('text/javascript', module);
    else if (path === '/theme.css') send('text/css', theme);
    else if (path === '/fixture.js')
      send(
        'text/javascript',
        "import * as ui from '/ui.js'; window.nvViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.nvViolations.push(e.violatedDirective)); window.nvUi = ui; window.nvController = ui.initUi(); document.documentElement.dataset.ready = '1';",
      );
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(views, { recursive: true, force: true });
});
beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(base);
  await page.waitForSelector('html[data-ready="1"]');
});
afterEach(async () => {
  expect(await page.evaluate(() => window.nvViolations)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});
const active = () => page.evaluate(() => document.activeElement?.id ?? '');
const dialogOpen = () =>
  page.evaluate(
    () => (document.getElementById('edit') as HTMLDialogElement).open,
  );

describe('dialog', () => {
  it('opens from the keyboard, traps Tab, keeps the background inert and returns focus on Escape', async () => {
    await page.getByRole('button', { name: 'Edit product' }).focus();
    await page.keyboard.press('Enter');
    expect(await dialogOpen()).toBe(true);
    expect(await active()).toBe('dialog-name');
    await page.keyboard.press('Tab');
    expect(await active()).toBe('dialog-save');
    await page.keyboard.press('Tab');
    // Wraps to the first focusable element (the close button in the header).
    expect(
      await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-nv-ui-close'),
      ),
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await active()).toBe('dialog-save');
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() =>
          document.getElementById('edit')?.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    // Background content is inert while the modal is open.
    expect(
      await page.evaluate(() => {
        document.getElementById('outside')?.focus();
        return document.activeElement?.id;
      }),
    ).not.toBe('outside');
    const blocked = page.locator('#outside').click({ timeout: 500 });
    await expect(blocked).rejects.toThrow();
    await page.keyboard.press('Escape');
    expect(await dialogOpen()).toBe(false);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('data-nv-ui-open'),
      ),
    ).toBe('edit');
  });
  it('closes on the close button, a matching Live event and a backdrop click, returning focus each time', async () => {
    const trigger = page.getByRole('button', { name: 'Edit product' });
    await trigger.click();
    await page.getByRole('button', { name: 'Close' }).click();
    expect(await dialogOpen()).toBe(false);
    await pw(trigger).toBeFocused();

    await trigger.click();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('nestvexa:event', {
          detail: { name: 'other-event', payload: null },
        }),
      ),
    );
    expect(await dialogOpen()).toBe(true);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('nestvexa:event', {
          detail: { name: 'product-created', payload: null },
        }),
      ),
    );
    expect(await dialogOpen()).toBe(false);
    await pw(trigger).toBeFocused();

    await trigger.click();
    await page.mouse.click(3, 3);
    expect(await dialogOpen()).toBe(false);
    await pw(trigger).toBeFocused();
  });
  it('restores focus to the opener when an open dialog is removed from the document', async () => {
    const trigger = page.getByRole('button', { name: 'Edit product' });
    await trigger.click();
    await page.evaluate(() => document.getElementById('edit')?.remove());
    await pw(trigger).toBeFocused();
  });
  it('passes axe with the dialog closed and open', async () => {
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'Edit product' }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

describe('theme', () => {
  it('follows dark mode and reduced-motion preferences and stays mirrored in RTL', async () => {
    const trigger = page.getByRole('button', { name: 'Edit product' });
    await trigger.click();
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.getElementById('edit') as Element)
            .animationName,
      ),
    ).toBe('nv-dialog-in');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await trigger.click();
    const styles = await page.evaluate(() => {
      const dialog = getComputedStyle(
        document.getElementById('edit') as Element,
      );
      return {
        animation: dialog.animationName,
        background: dialog.backgroundColor,
      };
    });
    expect(styles).toEqual({
      animation: 'none',
      background: 'rgb(18, 20, 23)',
    });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(
            document.body.querySelector('.nv-combobox__input') as Element,
          ).backgroundColor,
      ),
    ).toBe('rgb(255, 255, 255)');
    // Logical properties: the RTL tablist starts at the inline end.
    const order = await page.evaluate(() => {
      const first = document
        .getElementById('rtl-a-tab')
        ?.getBoundingClientRect();
      const second = document
        .getElementById('rtl-b-tab')
        ?.getBoundingClientRect();
      return (first?.left ?? 0) > (second?.left ?? 0);
    });
    expect(order).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

describe('tabs', () => {
  const state = (id: string) =>
    page.evaluate((tabs) => {
      const root = document.getElementById(tabs);
      return {
        listHidden: root
          ?.querySelector('[role="tablist"]')
          ?.hasAttribute('hidden'),
        selected: [...(root?.querySelectorAll('[role="tab"]') ?? [])]
          .filter((tab) => tab.getAttribute('aria-selected') === 'true')
          .map((tab) => tab.id),
        tabbable: [...(root?.querySelectorAll('[role="tab"]') ?? [])]
          .filter((tab) => tab.getAttribute('tabindex') === '0')
          .map((tab) => tab.id),
        visible: [...(root?.querySelectorAll('[role="tabpanel"]') ?? [])]
          .filter((panel) => !(panel as HTMLElement).hidden)
          .map((panel) => panel.id),
        focused: document.activeElement?.id,
      };
    }, id);
  it('reveals the tablist, hides inactive panels and uses a roving tabindex in LTR', async () => {
    expect(await state('ltr')).toMatchObject({
      listHidden: false,
      selected: ['ltr-a-tab'],
      tabbable: ['ltr-a-tab'],
      visible: ['ltr-a-panel'],
    });
    await page.locator('#ltr-a-tab').focus();
    await page.keyboard.press('ArrowRight');
    expect(await state('ltr')).toMatchObject({
      selected: ['ltr-b-tab'],
      tabbable: ['ltr-b-tab'],
      visible: ['ltr-b-panel'],
      focused: 'ltr-b-tab',
    });
    await page.keyboard.press('End');
    expect((await state('ltr')).focused).toBe('ltr-c-tab');
    await page.keyboard.press('ArrowRight');
    expect((await state('ltr')).focused).toBe('ltr-a-tab');
    await page.keyboard.press('ArrowLeft');
    expect((await state('ltr')).focused).toBe('ltr-c-tab');
    await page.keyboard.press('Home');
    expect((await state('ltr')).visible).toEqual(['ltr-a-panel']);
    // Tab moves from the tablist into the active panel.
    await page.keyboard.press('Tab');
    expect(await active()).toBe('ltr-a-panel');
  });
  it('mirrors arrow keys in RTL', async () => {
    await page.locator('#rtl-a-tab').focus();
    await page.keyboard.press('ArrowLeft');
    expect(await state('rtl')).toMatchObject({
      selected: ['rtl-b-tab'],
      focused: 'rtl-b-tab',
    });
    await page.keyboard.press('ArrowRight');
    expect((await state('rtl')).focused).toBe('rtl-a-tab');
  });
  it('initializes tabs inserted after startup', async () => {
    await page.evaluate(() => {
      const template = document.getElementById('late') as HTMLTemplateElement;
      document.getElementById('slot')?.append(template.content.cloneNode(true));
    });
    await expect
      .poll(() => state('late'))
      .toMatchObject({ listHidden: false, visible: ['late-x-panel'] });
  });
});

describe('combobox', () => {
  it('filters, navigates with aria-activedescendant and commits to the hidden input with events', async () => {
    await page.evaluate(() => {
      const hidden = document.getElementById('category-value');
      Reflect.set(window, 'nvEvents', []);
      for (const type of ['input', 'change'])
        hidden?.addEventListener(type, (event) =>
          (Reflect.get(window, 'nvEvents') as string[]).push(
            `${event.type}:${(event.target as HTMLInputElement).value}:${String(event.bubbles)}`,
          ),
        );
    });
    const input = page.getByRole('combobox', { name: 'Category' });
    await input.focus();
    await page.keyboard.type('o');
    await pw(input).toHaveAttribute('aria-expanded', 'true');
    await pw(page.locator('#category-listbox')).toBeVisible();
    await pw(page.locator('[data-nv-ui-status]')).toHaveText('3 results');
    await pw(page.locator('#category-opt-2')).toBeHidden();
    await page.keyboard.press('ArrowDown');
    await pw(input).toHaveAttribute('aria-activedescendant', 'category-opt-0');
    await pw(page.locator('#category-opt-0')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ArrowDown');
    await pw(input).toHaveAttribute('aria-activedescendant', 'category-opt-1');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    // Wraps to the last visible option (Toys).
    await pw(input).toHaveAttribute('aria-activedescendant', 'category-opt-3');
    await page.keyboard.press('Enter');
    await pw(input).toHaveValue('Toys');
    await pw(input).toHaveAttribute('aria-expanded', 'false');
    await pw(input).not.toHaveAttribute('aria-activedescendant');
    await pw(page.locator('#category-value')).toHaveValue('toys');
    expect(await page.evaluate(() => Reflect.get(window, 'nvEvents'))).toEqual([
      'input:toys:true',
      'change:toys:true',
    ]);
    expect(await active()).toBe('category');
  });
  it('announces empty results, clears stale values and supports Escape, Alt+ArrowDown and pointer selection', async () => {
    const input = page.getByRole('combobox', { name: 'Category' });
    await input.focus();
    await page.keyboard.type('gar');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await pw(page.locator('#category-value')).toHaveValue('garden');
    await page.keyboard.type('zzz');
    await pw(page.locator('[data-nv-ui-status]')).toHaveText('No matches');
    await pw(page.locator('#category-value')).toHaveValue('');
    await pw(input).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await pw(input).toHaveValue('');
    await page.keyboard.press('Alt+ArrowDown');
    await pw(input).toHaveAttribute('aria-expanded', 'true');
    await pw(input).not.toHaveAttribute('aria-activedescendant');
    await page.keyboard.press('Escape');
    await pw(input).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowDown');
    await page.locator('#category-opt-1').click();
    await pw(input).toHaveValue('Tools');
    await pw(page.locator('#category-value')).toHaveValue('tools');
    await pw(input).toBeFocused();
  });
});

describe('toasts', () => {
  it('renders Live event payloads as text in the polite region and errors in the alert region', async () => {
    await page.evaluate(() => {
      const send = (payload: unknown, name = 'toast') =>
        window.dispatchEvent(
          new CustomEvent('nestvexa:event', { detail: { name, payload } }),
        );
      send({ message: '<img src=x onerror="window.nvPwned=1">' });
      send({ message: 'Failed', tone: 'error' });
      send({ message: 42 });
      send(['not', 'an', 'object']);
      send({ message: 'other channel' }, 'not-toast');
    });
    const polite = page.locator('#toasts [data-nv-ui-list] .nv-toast__text');
    await pw(polite).toHaveText(['<img src=x onerror="window.nvPwned=1">']);
    await pw(page.locator('#toasts img')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'nvPwned'))).toBe(
      undefined,
    );
    await pw(
      page.locator('#toasts [role="status"][aria-live="polite"]'),
    ).toHaveCount(1);
    await pw(page.locator('#toasts [role="alert"] .nv-toast__text')).toHaveText(
      ['Failed'],
    );
  });
  it('supports sticky toasts, dismissal, auto-dismiss and a five toast cap', async () => {
    await page.evaluate(() => {
      const region = document.getElementById('toasts');
      if (!region) throw new Error('missing region');
      for (let index = 0; index < 7; index++)
        window.nvUi.showToast(region, `Toast ${index}`, { timeout: 0 });
    });
    await pw(page.locator('#toasts .nv-toast')).toHaveCount(5);
    await pw(page.locator('#toasts .nv-toast__text').first()).toHaveText(
      'Toast 2',
    );
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
    await pw(page.locator('#toasts .nv-toast')).toHaveCount(4);
    await page.evaluate(() => {
      const region = document.getElementById('toasts');
      if (region)
        window.nvUi.showToast(region, 'Short lived', { timeout: 100 });
    });
    await pw(page.getByText('Short lived')).toHaveCount(0);
    await expect(
      page.evaluate(() => {
        const region = document.getElementById('toasts');
        if (region) window.nvUi.showToast(region, '   ');
      }),
    ).rejects.toThrow();
    // Pausing on hover keeps a toast past its timeout.
    await page.evaluate(() => {
      const region = document.getElementById('toasts');
      if (region)
        Reflect.set(
          window,
          'nvHovered',
          window.nvUi.showToast(region, 'Hover me', { timeout: 400 }),
        );
    });
    await page.getByText('Hover me').hover();
    await page.waitForTimeout(700);
    await pw(page.getByText('Hover me')).toHaveCount(1);
  });
});

describe('controller lifecycle', () => {
  it('is idempotent per root, ignores duplicate nested handling and disposes every listener', async () => {
    expect(
      await page.evaluate(() => window.nvUi.initUi() === window.nvController),
    ).toBe(true);
    await page.evaluate(() =>
      Reflect.set(window, 'nvInner', window.nvUi.initUi(document.body)),
    );
    await page.locator('#ltr-a-tab').focus();
    await page.keyboard.press('ArrowRight');
    // Two controllers see the event but it moves exactly one tab.
    expect(await active()).toBe('ltr-b-tab');
    await page.evaluate(() => {
      window.nvController.dispose();
      (Reflect.get(window, 'nvInner') as { dispose(): void }).dispose();
    });
    await page.keyboard.press('ArrowRight');
    expect(await active()).toBe('ltr-b-tab');
    await page.getByRole('button', { name: 'Edit product' }).click();
    expect(await dialogOpen()).toBe(false);
    await page.evaluate(() => {
      const template = document.getElementById('late') as HTMLTemplateElement;
      document.getElementById('slot')?.append(template.content.cloneNode(true));
    });
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() =>
        document
          .querySelector('#late [role="tablist"]')
          ?.hasAttribute('hidden'),
      ),
    ).toBe(true);
    // A fresh controller after disposal works again.
    await page.evaluate(() => {
      window.nvController = window.nvUi.initUi();
    });
    await page.getByRole('button', { name: 'Edit product' }).click();
    expect(await dialogOpen()).toBe(true);
  });
});

describe('Node import safety', () => {
  it('imports the browser module without a DOM', async () => {
    const module = await import('../packages/ui/dist/browser/index.js');
    expect(typeof module.initUi).toBe('function');
    expect(typeof module.showToast).toBe('function');
    expect(typeof module.openDialog).toBe('function');
  });
});
