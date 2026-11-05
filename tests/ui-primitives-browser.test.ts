import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as pw, firefox, webkit } from '@playwright/test';
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
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { uiHelpers } from '../packages/ui/dist/index.js';

// Real browser interactions on shared CI hosts can exceed the default 15s.
vi.setConfig({ testTimeout: 45_000 });

declare global {
  interface Window {
    nvMenuEvents: unknown[];
    nvMirrorEvents: string[];
    nvViolations: string[];
  }
}

// Chromium by default; NV_UI_BROWSERS=chromium,firefox,webkit runs every engine.
const engines = { chromium, firefox, webkit } as const;
const selected = (process.env['NV_UI_BROWSERS'] ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is keyof typeof engines => name in engines);

const fixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>UI primitives fixture</title>
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/app.css" />
    <script type="module" src="/fixture.js"></script>
  </head>
  <body>
    <main>
      <h1>UI primitives fixture</h1>
      {{uiBreadcrumbs crumbs label="Breadcrumb"}}
      <p>Notifications {{uiBadge "{count} unread notifications" count=3 live=true id="unread"}}</p>
      {{#uiAlert tone="warning" title="Heads up" id="notice" dismissLabel="Dismiss notice"}}<p>Prices change tomorrow.</p>{{/uiAlert}}
      <button type="button" class="nv-button" id="outside">Outside</button>
      {{#uiMenu id="actions" label="Actions"}}
        {{uiMenuItem "Edit" href="/products/1"}}
        {{uiMenuItem "Copy id" value="copy"}}
        {{uiMenuItem "Archive" value="archive"}}
        {{uiMenuItem "Delete" value="delete" disabled=true}}
      {{/uiMenu}}
      {{#uiPopover id="help" label="Help" title="About prices"}}
        <p>Prices include tax.</p><a href="/pricing">Pricing policy</a>
      {{/uiPopover}}
      {{#uiTooltip id="vat-tip" text="Includes 14% VAT" label="Price help"}}<span aria-hidden="true">?</span>{{/uiTooltip}}
      {{#uiAccordion id="faq" level=2}}
        {{#uiAccordionItem id="ship" title="Shipping" open=true}}<p>Ships in two days.</p>{{/uiAccordionItem}}
        {{#uiAccordionItem id="returns" title="Returns"}}<p>Thirty day returns.</p>{{/uiAccordionItem}}
        {{#uiAccordionItem id="warranty" title="Warranty"}}<p>One year warranty.</p>{{/uiAccordionItem}}
      {{/uiAccordion}}
      {{uiDialogTrigger "filters" label="Open filters"}}
      {{uiDatePicker id="due" name="due" label="Due date" locale="en-US"}}
      {{uiDatePicker id="ship-date" model="shipDate" label="Ship date" locale="en-US" dateStyle="medium"}}
      <form id="upload-form" method="post" enctype="multipart/form-data" action="/upload">
        {{uiFileUpload id="files" name="files" label="Attachments" accept=".png,.pdf" multiple=true hint="PNG or PDF" dropLabel="Drop files here" selectedLabel="{count} files selected"}}
      </form>
      {{#uiWizard id="setup" label="Setup steps" current="account" stepLabel="Step {step} of {total}" completedLabel="completed"}}
        {{#uiWizardStep id="account" title="Account"}}<p>Account step</p>{{/uiWizardStep}}
        {{#uiWizardStep id="profile" title="Profile"}}<p>Profile step</p>{{/uiWizardStep}}
      {{/uiWizard}}
      <form id="bulk">
        {{uiTableSearch table="products" label="Search products" client=true resultsLabel="{count} results"}}
        {{uiTableFilter table="products" key="category" label="Category" allLabel="All categories" options=categories client=true resultsLabel="{count} results"}}
        {{#uiDataTable id="products" caption="Products" selectionLabel="{count} selected"}}
          <thead><tr>{{uiSelectAll table="products" label="Select all products"}}<th scope="col">Name</th><th scope="col">Category</th></tr></thead>
          <tbody>
            {{#each products}}
              <tr data-category="{{category}}">{{uiSelectRow name="ids" value=id label=selectLabel}}<td>{{name}}</td><td>{{category}}</td></tr>
            {{/each}}
          </tbody>
        {{/uiDataTable}}
      </form>
      <section dir="rtl" lang="ar" aria-label="عربي">
        {{uiBreadcrumbs crumbsAr label="مسار التنقل"}}
        {{uiDatePicker id="due-ar" name="dueAr" label="تاريخ الاستحقاق" locale="ar-EG"}}
        {{#uiMenu id="actions-ar" label="إجراءات"}}
          {{uiMenuItem "تعديل" href="/products/1"}}
          {{uiMenuItem "أرشفة" value="archive"}}
        {{/uiMenu}}
        {{uiDialogTrigger "filters-ar" label="فتح المرشحات"}}
      </section>
    </main>
    {{#uiDrawer id="filters" title="Filters" closeLabel="Close filters"}}
      <label for="min-price">Minimum price</label><input id="min-price" />
    {{/uiDrawer}}
    <div dir="rtl" lang="ar">
      {{#uiDrawer id="filters-ar" title="المرشحات" closeLabel="إغلاق"}}<p>محتوى</p>{{/uiDrawer}}
    </div>
  </body>
</html>`;

const model = {
  crumbs: [
    { label: 'Home', href: '/' },
    { label: 'Products', href: '/products' },
    { label: 'Atlas' },
  ],
  crumbsAr: [{ label: 'الرئيسية', href: '/' }, { label: 'المنتجات' }],
  categories: [
    { value: 'books', label: 'Books' },
    { value: 'tools', label: 'Tools' },
  ],
  products: [
    { id: 'p1', name: 'Atlas', category: 'books', selectLabel: 'Select Atlas' },
    {
      id: 'p2',
      name: 'Hammer',
      category: 'tools',
      selectLabel: 'Select Hammer',
    },
    {
      id: 'p3',
      name: 'Almanac',
      category: 'books',
      selectLabel: 'Select Almanac',
    },
  ],
};

let views: string;
let server: Server;
let base: string;
beforeAll(async () => {
  views = await mkdtemp(join(tmpdir(), 'nestvexa-ui-primitives-browser-'));
  await writeFile(join(views, 'fixture.hbs'), fixture);
  const engine = new HbsEngine({ root: views });
  engine.registerHelpers(uiHelpers());
  await engine.initialize();
  const html = await engine.render('fixture', model);
  await engine.dispose();
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
    // Applications paint their own surface with the theme tokens.
    else if (path === '/app.css')
      send(
        'text/css',
        'body { background: var(--nv-bg); color: var(--nv-text); font-family: var(--nv-font); }',
      );
    else if (path === '/fixture.js')
      send(
        'text/javascript',
        [
          "import * as ui from '/ui.js';",
          'window.nvViolations = []; window.nvMenuEvents = []; window.nvMirrorEvents = [];',
          "document.addEventListener('securitypolicyviolation', (e) => window.nvViolations.push(e.violatedDirective));",
          "document.addEventListener('nv-ui-menu-select', (e) => window.nvMenuEvents.push(e.detail));",
          "document.getElementById('ship-date-value').addEventListener('input', (e) => window.nvMirrorEvents.push(e.target.value));",
          'ui.initUi();',
          "document.documentElement.dataset.ready = '1';",
        ].join('\n'),
      );
    else
      send('text/html; charset=utf-8', '<!doctype html><title>Other</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(views, { recursive: true, force: true });
});

describe.each(selected)('UI primitives in %s', (engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  beforeAll(async () => {
    browser = await engines[engine].launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // Playwright's WebKit logs this for its own UA stylesheet whenever a
      // plain <select> renders under style-src 'self' (reproducible with a
      // page containing only <select>); no securitypolicyviolation event fires
      // and nvViolations stays empty, so page CSP compliance is still asserted.
      if (
        engine === 'webkit' &&
        message
          .text()
          .startsWith('Refused to apply a stylesheet because its hash')
      )
        return;
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
  const active = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      return element?.id || element?.textContent?.trim() || '';
    });
  const axe = async () =>
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  describe('menu button', () => {
    const button = () => page.locator('#actions-button');
    const expanded = () => button().getAttribute('aria-expanded');
    it('opens from the keyboard and moves through items with arrows, Home, End and type-ahead', async () => {
      expect(await page.locator('#actions-menu').isHidden()).toBe(true);
      await button().focus();
      await page.keyboard.press('Enter');
      expect(await expanded()).toBe('true');
      expect(await active()).toBe('Edit');
      await page.keyboard.press('ArrowDown');
      expect(await active()).toBe('Copy id');
      await page.keyboard.press('End');
      expect(await active()).toBe('Delete');
      await page.keyboard.press('ArrowDown');
      expect(await active()).toBe('Edit');
      await page.keyboard.press('ArrowUp');
      expect(await active()).toBe('Delete');
      await page.keyboard.press('Home');
      expect(await active()).toBe('Edit');
      await page.keyboard.press('a');
      expect(await active()).toBe('Archive');
      await page.keyboard.press('Escape');
      expect(await expanded()).toBe('false');
      expect(await active()).toBe('actions-button');
      await page.keyboard.press('ArrowUp');
      expect(await active()).toBe('Delete');
      await page.keyboard.press('Tab');
      expect(await expanded()).toBe('false');
    });
    it('reports value items, ignores disabled items and closes on outside clicks', async () => {
      await button().click();
      await page
        .getByRole('menuitem', { name: 'Delete' })
        .click({ force: true });
      expect(await expanded()).toBe('true');
      await page.getByRole('menuitem', { name: 'Archive' }).click();
      expect(await expanded()).toBe('false');
      expect(await active()).toBe('actions-button');
      await page.keyboard.press('Space');
      expect(await expanded()).toBe('true');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.nvMenuEvents)).toEqual([
        { menu: 'actions', value: 'archive' },
        { menu: 'actions', value: 'copy' },
      ]);
      await button().click();
      await page.locator('#outside').click();
      expect(await expanded()).toBe('false');
    });
    it('is restored to closed when a server re-render brings back the collapsed marker', async () => {
      await button().click();
      await page.evaluate(() => {
        const list = document.getElementById('actions-menu');
        list?.removeAttribute('hidden');
        list?.setAttribute('data-nv-ui-collapsed', '');
      });
      await pw(page.locator('#actions-menu')).toBeHidden();
      expect(await expanded()).toBe('false');
    });
  });

  describe('accordion', () => {
    const trigger = (id: string) => page.locator(`#faq-${id}-trigger`);
    it('toggles panels with the keyboard, keeps one open and moves focus between headers', async () => {
      await pw(page.locator('#faq-ship-panel')).toBeVisible();
      await pw(page.locator('#faq-returns-panel')).toBeHidden();
      await trigger('ship').focus();
      await page.keyboard.press('ArrowDown');
      expect(await active()).toBe('faq-returns-trigger');
      await page.keyboard.press('Enter');
      expect(await trigger('returns').getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(await trigger('ship').getAttribute('aria-expanded')).toBe('false');
      await pw(page.locator('#faq-returns-panel')).toBeVisible();
      await pw(page.locator('#faq-ship-panel')).toBeHidden();
      await page.keyboard.press('Space');
      await pw(page.locator('#faq-returns-panel')).toBeHidden();
      await page.keyboard.press('End');
      expect(await active()).toBe('faq-warranty-trigger');
      await page.keyboard.press('ArrowDown');
      expect(await active()).toBe('faq-ship-trigger');
      await page.keyboard.press('ArrowUp');
      expect(await active()).toBe('faq-warranty-trigger');
      await page.keyboard.press('Home');
      expect(await active()).toBe('faq-ship-trigger');
    });
    it('keeps collapsed content readable when scripting is disabled', async () => {
      const plain = await browser.newContext({ javaScriptEnabled: false });
      const noScript = await plain.newPage();
      await noScript.goto(base);
      await pw(noScript.locator('#faq-returns-panel')).toBeVisible();
      await pw(noScript.locator('#actions-menu')).toBeVisible();
      await plain.close();
    });
  });

  describe('popover and tooltip', () => {
    it('moves focus into the popover, closes on Escape and returns focus', async () => {
      const trigger = page.locator('#help-trigger');
      await trigger.focus();
      await page.keyboard.press('Enter');
      expect(await trigger.getAttribute('aria-expanded')).toBe('true');
      expect(await active()).toBe('Pricing policy');
      await pw(
        page.getByRole('dialog', { name: 'About prices' }),
      ).toBeVisible();
      await axe();
      await page.keyboard.press('Escape');
      expect(await trigger.getAttribute('aria-expanded')).toBe('false');
      expect(await active()).toBe('help-trigger');
      await trigger.click();
      await page.locator('#outside').click();
      await pw(page.locator('#help-panel')).toBeHidden();
      await trigger.click();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await pw(page.locator('#help-panel')).toBeHidden();
    });
    it('shows the tooltip on focus and hover, keeps it hoverable and dismisses it on Escape', async () => {
      const trigger = page.getByRole('button', { name: 'Price help' });
      await pw(trigger).toHaveAccessibleDescription('Includes 14% VAT');
      const bubble = page.locator('#vat-tip');
      await pw(bubble).toBeHidden();
      await trigger.focus();
      await pw(bubble).toBeVisible();
      await page.keyboard.press('Escape');
      await pw(bubble).toBeHidden();
      await pw(trigger).toBeFocused();
      await page.locator('#outside').focus();
      await trigger.hover();
      await pw(bubble).toBeVisible();
      await bubble.hover();
      await pw(bubble).toBeVisible();
      await page.locator('h1').hover();
      await pw(bubble).toBeHidden();
    });
  });

  describe('drawer', () => {
    it('opens as a modal side panel, traps focus and follows the text direction', async () => {
      await page.getByRole('button', { name: 'Open filters' }).click();
      const drawer = page.getByRole('dialog', { name: 'Filters' });
      await pw(drawer).toBeVisible();
      expect(await active()).toBe('min-price');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() =>
          document.getElementById('filters')?.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      await axe();
      const ltr = await drawer.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(Math.round((ltr?.x ?? 0) + (ltr?.width ?? 0))).toBe(width);
      await page.keyboard.press('Escape');
      expect(await active()).toBe('Open filters');
      await page.getByRole('button', { name: 'فتح المرشحات' }).click();
      const rtl = await page
        .getByRole('dialog', { name: 'المرشحات' })
        .boundingBox();
      // side="end" is the left edge in a right-to-left context.
      expect(Math.round(rtl?.x ?? -1)).toBe(0);
      await page.keyboard.press('Escape');
    });
  });

  describe('date picker', () => {
    it('formats the chosen date for the locale and mirrors it into the Live model input', async () => {
      await page.locator('#due').fill('2026-03-01');
      await pw(page.locator('#due-formatted')).toHaveText('March 1, 2026');
      expect(await page.locator('#due').getAttribute('aria-describedby')).toBe(
        'due-formatted',
      );
      await page.locator('#due-ar').fill('2026-03-01');
      const expected = await page.evaluate(() =>
        new Intl.DateTimeFormat('ar-EG', {
          dateStyle: 'long',
          timeZone: 'UTC',
        }).format(new Date('2026-03-01T00:00:00Z')),
      );
      await pw(page.locator('#due-ar-formatted')).toHaveText(expected);
      await page.locator('#ship-date').fill('2026-12-24');
      await pw(page.locator('#ship-date-formatted')).toHaveText('Dec 24, 2026');
      expect(await page.locator('#ship-date-value').inputValue()).toBe(
        '2026-12-24',
      );
      expect(await page.evaluate(() => window.nvMirrorEvents)).toContain(
        '2026-12-24',
      );
    });
  });

  describe('file uploader', () => {
    it('lists chosen files as text and announces the count', async () => {
      await pw(page.locator('[data-nv-ui-drop]')).toBeVisible();
      await page.locator('#files').setInputFiles([
        {
          name: '<img src=x onerror=alert(1)>.png',
          mimeType: 'image/png',
          buffer: Buffer.from('png'),
        },
        {
          name: 'report.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.alloc(2048),
        },
      ]);
      await pw(page.locator('#files-selection')).toHaveText('2 files selected');
      const items = page.locator('.nv-upload__file');
      await pw(items).toHaveCount(2);
      await pw(items.first()).toContainText('<img src=x onerror=alert(1)>.png');
      expect(await page.locator('.nv-upload__files img').count()).toBe(0);
      await pw(items.nth(1)).toContainText('report.pdf (2 kB)');
    });
    it('accepts dropped files that match accept and notifies change listeners', async () => {
      const result = await page.evaluate(() => {
        let changes = 0;
        const input = document.getElementById('files') as HTMLInputElement;
        input.addEventListener('change', () => changes++);
        const transfer = new DataTransfer();
        transfer.items.add(new File(['x'], 'photo.png', { type: 'image/png' }));
        transfer.items.add(
          new File(['x'], 'tool.exe', { type: 'application/octet-stream' }),
        );
        const zone = document.querySelector('[data-nv-ui-drop]') as HTMLElement;
        zone.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        const dragging = zone
          .closest('[data-nv-ui="upload"]')
          ?.hasAttribute('data-nv-ui-dragging');
        zone.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        return {
          dragging,
          names: [...(input.files ?? [])].map((file) => file.name),
          changes,
        };
      });
      expect(result).toEqual({
        dragging: true,
        names: ['photo.png'],
        changes: 1,
      });
      await pw(page.locator('#files-selection')).toHaveText('1 files selected');
    });
  });

  describe('wizard', () => {
    it('moves focus to the new step heading only when the step changes in place', async () => {
      expect(await active()).not.toBe('setup-heading');
      await page.evaluate(() => {
        // Simulates a Live morph that advances the server-driven wizard.
        const wizard = document.getElementById('setup');
        const heading = wizard?.querySelector('.nv-wizard__heading');
        if (heading) heading.textContent = 'Step 2 of 2: Profile';
        wizard?.setAttribute('data-nv-ui-current', 'profile');
      });
      await pw(page.locator('#setup-heading')).toBeFocused();
      await pw(page.locator('[aria-current="step"]')).toContainText('Account');
    });
  });

  describe('data table', () => {
    const status = () => page.locator('#products-status');
    const visibleRows = () => page.locator('#products tbody tr:visible');
    it('filters rows by search and category and announces the result count', async () => {
      await page
        .getByRole('searchbox', { name: 'Search products' })
        .fill('books');
      await pw(visibleRows()).toHaveCount(2);
      await pw(status()).toHaveText('2 results');
      await page.getByLabel('Category').selectOption('tools');
      await pw(visibleRows()).toHaveCount(0);
      await pw(status()).toHaveText('0 results');
      await page.getByRole('searchbox', { name: 'Search products' }).fill('');
      await pw(visibleRows()).toHaveCount(1);
      await page.getByLabel('Category').selectOption('');
      await pw(visibleRows()).toHaveCount(3);
      await pw(status()).toHaveText('');
    });
    it('selects visible rows, shows the mixed state and posts the chosen values', async () => {
      const all = page.getByRole('checkbox', { name: 'Select all products' });
      await page.getByLabel('Category').selectOption('books');
      await all.check();
      await pw(status()).toHaveText('2 results. 2 selected');
      expect(await page.locator('input[value="p2"]').isChecked()).toBe(false);
      await page.getByLabel('Category').selectOption('');
      expect(
        await all.evaluate((box) => (box as HTMLInputElement).indeterminate),
      ).toBe(true);
      await page.getByRole('checkbox', { name: 'Select Hammer' }).check();
      expect(await all.isChecked()).toBe(true);
      await page.getByRole('checkbox', { name: 'Select Atlas' }).uncheck();
      await pw(status()).toHaveText('2 selected');
      expect(
        await page.evaluate(() =>
          new FormData(
            document.getElementById('bulk') as HTMLFormElement,
          ).getAll('ids'),
        ),
      ).toEqual(['p2', 'p3']);
      expect(
        await page.locator('#products tr[data-nv-ui-selected]').count(),
      ).toBe(2);
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Space');
      expect(
        await page
          .getByRole('checkbox', { name: 'Select all products' })
          .isChecked(),
      ).toBe(true);
    });
  });

  describe('alert, badge and breadcrumbs', () => {
    it('reveals the dismiss button and moves focus to main when dismissing', async () => {
      const dismiss = page.getByRole('button', { name: 'Dismiss notice' });
      await pw(dismiss).toBeVisible();
      await dismiss.focus();
      await page.keyboard.press('Enter');
      await pw(page.locator('#notice')).toHaveCount(0);
      expect(await page.evaluate(() => document.activeElement?.localName)).toBe(
        'main',
      );
      await pw(
        page.getByRole('status').filter({ hasText: '3 unread notifications' }),
      ).toHaveCount(1);
      await pw(
        page
          .getByRole('navigation', { name: 'Breadcrumb' })
          .getByRole('link', { name: 'Products' }),
      ).toBeVisible();
      await pw(page.locator('[aria-current="page"]').first()).toHaveText(
        'Atlas',
      );
    });
  });

  describe('accessibility', () => {
    it('has no axe violations in light, dark, reduced-motion and RTL states', async () => {
      await axe();
      await page.locator('#actions-button').click();
      await axe();
      await page.keyboard.press('Escape');
      await page.locator('#actions-ar-button').click();
      // RTL menu opens anchored to the inline start (the right edge).
      const box = await page.locator('#actions-ar-menu').boundingBox();
      const button = await page.locator('#actions-ar-button').boundingBox();
      expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(
        Math.round((button?.x ?? 0) + (button?.width ?? 0)),
      );
      await axe();
      await page.keyboard.press('Escape');
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await axe();
      await page.getByRole('button', { name: 'Open filters' }).click();
      expect(
        await page.evaluate(
          () =>
            getComputedStyle(document.getElementById('filters') as Element)
              .animationName,
        ),
      ).toBe('none');
      await axe();
    });
  });
});
