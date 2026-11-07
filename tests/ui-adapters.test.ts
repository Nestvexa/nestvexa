import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as pw, firefox, webkit } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import {
  UiError,
  chartMarkup,
  datePickerMarkup,
  dialogMarkup,
  menuMarkup,
  radioGroupFieldMarkup,
  renderMarkup,
  selectFieldMarkup,
  tableFilterMarkup,
  tableSearchMarkup,
  tabsMarkup,
  textFieldMarkup,
} from '../packages/ui/dist/markup.js';
import {
  categories,
  countries,
  months,
  plans,
  products,
  sales,
  visitors,
} from './fixtures/ui-adapters/data.mjs';

// The React, Vue and Svelte wrappers of @nestvexa/ui render the shared markup
// contract and reuse the keyboard module. This suite proves (1) their SSR
// output is the HBS helpers' markup, (2) they hydrate without mismatches under
// a strict CSP and (3) keyboard behavior, framework callbacks, axe and
// unmount/remount work in a real browser.
vi.setConfig({ testTimeout: 60_000 });

declare global {
  interface Window {
    nvErrors: string[];
    nvViolations: string[];
  }
}

const engines = { chromium, firefox, webkit } as const;
const selected = (process.env['NV_UI_BROWSERS'] ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is keyof typeof engines => name in engines);

const root = resolve(import.meta.dirname, '..');
const ui = join(root, 'packages/ui');
const fixtures = join(root, 'tests/fixtures/ui-adapters');
const uiRequire = createRequire(join(ui, 'package.json'));
const { compile } = uiRequire('svelte/compiler') as {
  compile(
    source: string,
    options: { filename: string; generate: 'client' | 'server'; dev: boolean },
  ): { js: { code: string } };
};

/** The same page as the framework fixtures, written with the HBS helpers. */
const template = `<div id="kit"><h1>UI kit</h1>{{uiDialogTrigger "kit-dialog" label="Open dialog"}}<p id="dialog-log">Closed 0</p>{{#uiTabs id="kit-tabs" label="Sections"}}{{#uiTab id="overview" label="Overview"}}<p>Overview panel</p>{{/uiTab}}{{#uiTab id="details" label="Details"}}<p>Details panel</p>{{/uiTab}}{{#uiTab id="history" label="History"}}<p>History panel</p>{{/uiTab}}{{/uiTabs}}{{#uiMenu id="kit-menu" label="Actions"}}{{uiMenuItem "Edit" href="/kit/edit"}}{{uiMenuItem "Copy id" value="copy"}}{{uiMenuItem "Archive" value="archive"}}{{uiMenuItem "Delete" value="delete" disabled=true}}{{/uiMenu}}<p id="menu-log"></p><button type="button" id="notify" class="nv-button">Notify</button>{{uiToastRegion id="kit-toasts" label="Notifications" dismissLabel="Dismiss"}}{{uiDatePicker id="kit-due" name="due" label="Due date" locale="en-US" value="2026-03-04"}}<p id="date-log"></p><form id="bulk">{{uiTableSearch table="kit-table" label="Search products" client=true resultsLabel="{count} results"}}{{uiTableFilter table="kit-table" key="category" label="Category" allLabel="All categories" options=categories client=true resultsLabel="{count} results"}}{{#uiDataTable id="kit-table" caption="Products" selectionLabel="{count} selected"}}<thead><tr>{{uiSelectAll table="kit-table" label="Select all products"}}<th scope="col">Name</th><th scope="col">Category</th></tr></thead><tbody>{{#each products}}<tr data-category="{{category}}">{{uiSelectRow name="ids" value=id label=label}}<td>{{name}}</td><td>{{category}}</td></tr>{{/each}}</tbody>{{/uiDataTable}}</form>{{#uiDialog id="kit-dialog" title="Edit item" closeLabel="Close dialog"}}<label for="kit-name">Name</label><input id="kit-name">{{/uiDialog}}<form id="kit-profile">{{uiTextField id="kit-email" name="email" label="Email" type="email" hint="We never share it." error="Enter a valid email address." required=true autocomplete="email"}}{{uiTextField id="kit-nick" name="nickname" label="Nickname" value="Ada"}}{{uiTextareaField id="kit-bio" name="bio" label="Biography" rows=3 value="Hello"}}{{uiSelectField id="kit-country" name="country" label="Country" options=countries placeholder="Choose a country" required=true}}{{uiCheckboxField id="kit-terms" name="terms" label="I accept the terms" value="yes" error="You must accept the terms."}}{{uiRadioGroupField id="kit-plan" name="plan" label="Plan" options=plans hint="Change it later." value="basic"}}</form><p id="field-log"></p><div id="kit-charts">{{uiChart id="kit-sales" title="Monthly sales" description="Online sales peaked in March." categoryLabel="Month" labels=months series=sales locale="en-US"}}{{uiChart id="kit-trend" type="line" title="Visitors" categoryLabel="Month" labels=months series=visitors showTable=true}}{{uiChart id="kit-spark" type="sparkline" title="Weekly visitors" categoryLabel="Month" labels=months series=visitors}}{{#uiChart id="kit-ext" type="custom" title="Third-party visits" categoryLabel="Month" labels=months series=visitors}}<canvas id="kit-ext-chart" width="320" height="120"></canvas>{{/uiChart}}</div></div>`;

type Framework = 'react' | 'vue' | 'svelte';
const frameworks: readonly Framework[] = ['react', 'vue', 'svelte'];

const subpaths: Readonly<Record<string, string>> = {
  markup: join(ui, 'dist/markup.js'),
  browser: join(ui, 'dist/browser/index.js'),
  react: join(ui, 'dist/adapters/react.js'),
  vue: join(ui, 'dist/adapters/vue.js'),
  svelte: join(ui, 'svelte/index.js'),
};
/** Resolves @nestvexa/ui subpaths to one copy each and compiles .svelte files. */
function uiPlugin(generate: 'client' | 'server'): Plugin {
  return {
    name: 'nestvexa-ui',
    setup(builder) {
      builder.onResolve({ filter: /^@nestvexa\/ui\/[a-z]+$/ }, (args) => {
        const path = subpaths[args.path.slice('@nestvexa/ui/'.length)];
        return path ? { path } : undefined;
      });
      builder.onLoad({ filter: /\.svelte$/ }, async (args) => ({
        contents: compile(await readFile(args.path, 'utf8'), {
          filename: args.path,
          generate,
          dev: true,
        }).js.code,
        loader: 'js',
        resolveDir: dirname(args.path),
      }));
    },
  };
}
const define = {
  'process.env.NODE_ENV': '"development"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'true',
};
const ssrEntries: Readonly<Record<Framework, string>> = {
  react: `import { createElement } from 'react'; import { renderToString } from 'react-dom/server'; import { App } from './react-app.mjs'; export const render = async () => renderToString(createElement(App));`,
  vue: `import { createSSRApp } from 'vue'; import { renderToString } from 'vue/server-renderer'; import { App } from './vue-app.mjs'; export const render = () => renderToString(createSSRApp(App));`,
  svelte: `import { render as renderApp } from 'svelte/server'; import App from './App.svelte'; export const render = async () => renderApp(App).body;`,
};
const clientEntries: Readonly<Record<Framework, string>> = {
  react: `import { createElement } from 'react'; import { hydrateRoot } from 'react-dom/client'; import { App } from './react-app.mjs'; hydrateRoot(document.getElementById('app'), createElement(App), { onRecoverableError: (error) => window.nvErrors.push(String(error)) }); requestAnimationFrame(() => document.documentElement.dataset.ready = '1');`,
  vue: `import { createSSRApp } from 'vue'; import { App } from './vue-app.mjs'; const app = createSSRApp(App); app.config.errorHandler = (error) => window.nvErrors.push(String(error)); app.mount('#app'); document.documentElement.dataset.ready = '1';`,
  svelte: `import { hydrate } from 'svelte'; import App from './App.svelte'; hydrate(App, { target: document.getElementById('app') }); document.documentElement.dataset.ready = '1';`,
};
const prelude = `window.nvErrors = []; window.nvViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.nvViolations.push(e.violatedDirective));`;

async function bundle(
  framework: Framework,
  kind: 'ssr' | 'client',
  outfile: string,
): Promise<void> {
  await build({
    stdin: {
      contents:
        kind === 'ssr' ? ssrEntries[framework] : clientEntries[framework],
      resolveDir: fixtures,
      sourcefile: `${framework}-${kind}.mjs`,
    },
    bundle: true,
    format: 'esm',
    outfile,
    platform: kind === 'ssr' ? 'node' : 'browser',
    conditions:
      kind === 'ssr'
        ? ['svelte', 'development']
        : ['svelte', 'browser', 'development'],
    nodePaths: [join(ui, 'node_modules')],
    plugins: [uiPlugin(kind === 'ssr' ? 'server' : 'client')],
    define,
    logLevel: 'silent',
    ...(kind === 'client' ? { banner: { js: prelude } } : {}),
  });
}

const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'";
let work: string;
let server: Server;
let base: string;
let hbsKit: string;
const ssr = new Map<Framework, string>();

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'nestvexa-ui-adapters-'));
  await writeFile(join(work, 'kit.hbs'), template);
  const engine = new HbsEngine({ root: work });
  engine.registerHelpers(uiHelpers());
  await engine.initialize();
  hbsKit = await engine.render('kit', {
    categories,
    countries,
    plans,
    months,
    sales,
    visitors,
    products: products.map((product) => ({
      ...product,
      label: `Select ${product.name}`,
    })),
  });
  await engine.dispose();
  const assets = new Map<string, string>();
  for (const framework of frameworks) {
    const ssrFile = join(work, `${framework}-ssr.mjs`);
    await bundle(framework, 'ssr', ssrFile);
    const module = (await import(pathToFileURL(ssrFile).href)) as {
      render(): Promise<string>;
    };
    ssr.set(framework, await module.render());
    const clientFile = join(work, `${framework}.js`);
    await bundle(framework, 'client', clientFile);
    assets.set(`/${framework}.js`, await readFile(clientFile, 'utf8'));
  }
  const theme = await readFile(join(ui, 'theme/theme.css'), 'utf8');
  const page = (framework: Framework) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${framework} UI kit</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/app.css"><script type="module" src="/${framework}.js"></script></head><body><main id="app">${ssr.get(framework) ?? ''}</main></body></html>`;
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const send = (type: string, body: string) =>
      response
        .writeHead(200, {
          'content-type': type,
          'content-security-policy': csp,
        })
        .end(body);
    const framework = frameworks.find((name) => path === `/${name}`);
    const asset = assets.get(path);
    if (framework) send('text/html; charset=utf-8', page(framework));
    else if (asset !== undefined) send('text/javascript', asset);
    else if (path === '/theme.css') send('text/css', theme);
    else if (path === '/app.css')
      send(
        'text/css',
        'body { background: var(--nv-bg); color: var(--nv-text); font-family: var(--nv-font); }',
      );
    else
      send('text/html; charset=utf-8', '<!doctype html><title>Other</title>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(work, { recursive: true, force: true });
});

describe('markup contract', () => {
  it('renders the slot content of a dialog as given and escapes text', () => {
    const html = renderMarkup(
      dialogMarkup({ id: 'd', title: '<b>Title</b>', closeLabel: 'Close "x"' }),
      { body: '<p>trusted body</p>' },
    );
    expect(html).toContain('&lt;b&gt;Title&lt;/b&gt;');
    expect(html).toContain('aria-label="Close &quot;x&quot;"');
    expect(html).toContain(
      '<div class="nv-dialog__body"><p>trusted body</p></div>',
    );
  });
  it('rejects unsafe ids, links, structure and dates from framework props', () => {
    const cases: (() => unknown)[] = [
      () => dialogMarkup({ id: '1bad', title: 'T', closeLabel: 'C' }),
      () => dialogMarkup({ id: '__proto__', title: 'T', closeLabel: 'C' }),
      () =>
        dialogMarkup({
          id: 'd',
          title: 'T',
          closeLabel: 'C',
          drawer: true,
          side: 'top',
        }),
      () =>
        menuMarkup({
          id: 'm',
          label: 'M',
          items: [{ label: 'x', href: 'javascript:alert(1)' }],
        }),
      () =>
        menuMarkup({
          id: 'm',
          label: 'M',
          items: [{ label: 'x', href: '//evil.test' }],
        }),
      () =>
        menuMarkup({
          id: 'm',
          label: 'M',
          items: [{ label: 'x', value: 'a', href: '/a' }],
        }),
      () =>
        menuMarkup({
          id: 'm',
          label: 'M',
          items: [{ label: 'x', value: 'a', onclick: 'x' }],
        }),
      () => menuMarkup({ id: 'm', label: 'M', items: [] }),
      () =>
        tabsMarkup({
          id: 't',
          label: 'T',
          tabs: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
        }),
      () =>
        tabsMarkup({
          id: 't',
          label: 'T',
          tabs: [
            { id: 'a', label: 'A', selected: true },
            { id: 'b', label: 'B', selected: true },
          ],
        }),
      () =>
        tabsMarkup({
          id: 't',
          label: 'T',
          tabs: [{ id: 'a', label: 'A', content: '<p>' }],
        }),
      () =>
        datePickerMarkup({
          id: 'd',
          name: 'd',
          label: 'D',
          value: '2026-02-30',
        }),
      () =>
        datePickerMarkup({
          id: 'd',
          name: 'd',
          label: 'D',
          locale: 'not a locale!',
        }),
      () =>
        datePickerMarkup({
          id: 'd',
          name: 'd',
          label: 'D',
          min: '2026-05-01',
          max: '2026-01-01',
        }),
      () => tableSearchMarkup({ table: 't', label: 'S', client: true }),
      () =>
        tableFilterMarkup({
          table: 't',
          key: 'Bad Key',
          label: 'F',
          allLabel: 'All',
          options: categories,
        }),
      () =>
        tableFilterMarkup({
          table: 't',
          key: 'k',
          label: 'F',
          allLabel: 'All',
          options: categories,
          value: 'other',
        }),
    ];
    for (const run of cases) expect(run).toThrow(UiError);
  });
  it('escapes field and chart text from framework props and rejects unsafe values', () => {
    const attack = '"><script>alert(1)</script><x onclick="y';
    const field = renderMarkup(
      textFieldMarkup({
        id: 'f',
        name: 'f',
        label: attack,
        hint: attack,
        error: [attack],
        value: attack,
      }),
    );
    const chart = renderMarkup(
      chartMarkup({
        id: 'c',
        title: attack,
        description: attack,
        categoryLabel: attack,
        labels: [attack],
        series: [{ name: attack, values: [1] }],
      }),
    );
    for (const html of [field, chart]) {
      expect(html).not.toMatch(/<script|<x |\sonclick=/);
      expect(html).toContain('&lt;script&gt;');
    }
    const cases: (() => unknown)[] = [
      () => textFieldMarkup({ id: 'f" x="', name: 'f', label: 'F' }),
      () => textFieldMarkup({ id: 'f', name: 'f onclick=', label: 'F' }),
      () => textFieldMarkup({ id: 'f', name: '__proto__', label: 'F' }),
      () => textFieldMarkup({ id: 'f', name: 'f', label: 'F', type: 'file' }),
      () =>
        textFieldMarkup({
          id: 'f',
          label: 'F',
          model: 'a',
          modelModifiers: 'x" onclick="y',
        }),
      () =>
        selectFieldMarkup({
          id: 's',
          name: 's',
          label: 'S',
          options: countries,
          value: 'other',
        }),
      () =>
        radioGroupFieldMarkup({
          id: 'r',
          name: 'r',
          label: 'R',
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'B' },
          ],
        }),
      ...[Number.NaN, Number.POSITIVE_INFINITY, '1', null, 1e16].map(
        (value) => () =>
          chartMarkup({
            id: 'c',
            title: 'T',
            categoryLabel: 'C',
            labels: ['a'],
            series: [{ name: 'S', values: [value] }],
          }),
      ),
      () =>
        chartMarkup({
          id: 'c',
          title: 'T',
          categoryLabel: 'C',
          labels: Array.from({ length: 201 }, (_, index) => `l${index}`),
          series: [{ name: 'S', values: Array(201).fill(1) }],
        }),
      () =>
        chartMarkup({
          id: 'c',
          title: 'T',
          categoryLabel: 'C',
          labels: ['a'],
          series: Array.from({ length: 9 }, (_, index) => ({
            name: `s${index}`,
            values: [1],
          })),
        }),
    ];
    for (const run of cases) expect(run).toThrow(UiError);
  });
});

/** Canonical DOM serialization: comments, blank text and attribute order ignored. */
function canonical(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}</body>`,
    'text/html',
  );
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return /^\s*$/.test(node.textContent ?? '')
        ? ''
        : escape(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as Element;
    element.normalize();
    const attributes = [...element.attributes]
      .map((attribute) => `${attribute.name}="${escape(attribute.value)}"`)
      .sort()
      .join(' ');
    return `<${element.localName}${attributes ? ` ${attributes}` : ''}>${[
      ...element.childNodes,
    ]
      .map(serialize)
      .join('')}</${element.localName}>`;
  };
  const kit = doc.getElementById('kit');
  return kit ? serialize(kit) : '';
}

describe.each(selected)('UI kit wrappers in %s', (engine) => {
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

  it('server-render exactly the markup of the HBS helpers', async () => {
    const scratch = await browser.newPage();
    const expected = await scratch.evaluate(canonical, hbsKit);
    expect(expected).toContain('data-nv-ui="menu"');
    for (const framework of frameworks)
      expect(
        await scratch.evaluate(canonical, ssr.get(framework) ?? ''),
        framework,
      ).toBe(expected);
    await scratch.close();
  });

  describe.each(frameworks)('%s', (framework) => {
    beforeEach(async () => {
      context = await browser.newContext();
      page = await context.newPage();
      errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        // See tests/ui-primitives-browser.test.ts: WebKit's UA stylesheet
        // for <select> logs this under style-src 'self' without a violation.
        if (
          engine === 'webkit' &&
          message
            .text()
            .startsWith('Refused to apply a stylesheet because its hash')
        )
          return;
        // React's development build marks render phases with
        // console.timeStamp('Hydrated', …); Firefox surfaces those as console
        // messages. They are performance-track labels, not hydration errors.
        // (Playwright's ConsoleMessage type union does not list `timeStamp`.)
        const type: string = message.type();
        if (type === 'timeStamp') return;
        if (message.type() === 'error' || /hydrat/i.test(message.text()))
          errors.push(message.text());
      });
      await page.goto(`${base}/${framework}`);
      await page.waitForSelector('html[data-ready="1"]');
      // The tab list is revealed by the keyboard module once connected.
      await page.waitForSelector('#kit-tabs [role="tablist"]:not([hidden])');
    });
    afterEach(async () => {
      // WebKit reports a style-src-attr violation for the UA shadow tree of a
      // <select> created by script (reproduced with a bare
      // document.createElement('select') on a strict-CSP page); the remount
      // test recreates the table filter's <select>. Other engines report none.
      const violations = await page.evaluate(() => window.nvViolations);
      expect(
        engine === 'webkit'
          ? violations.filter((entry) => entry !== 'style-src-attr')
          : violations,
      ).toEqual([]);
      expect(await page.evaluate(() => window.nvErrors)).toEqual([]);
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

    // The first axe run per page is slow in Firefox on loaded hosts.
    it('hydrates with no axe violations', async () => {
      await axe();
    }, 180_000);

    it('opens the dialog from its trigger, traps focus, closes on Escape and reports close', async () => {
      await page.locator('[data-nv-ui-open="kit-dialog"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#kit-dialog[open]');
      expect(await active()).toBe('kit-name');
      await page.keyboard.press('Tab');
      expect(await active()).not.toBe('notify');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      const inside = await page.evaluate(() =>
        document.getElementById('kit-dialog')?.contains(document.activeElement),
      );
      expect(inside).toBe(true);
      await axe();
      await page.keyboard.press('Escape');
      await page.waitForSelector('#kit-dialog:not([open])', {
        state: 'attached',
      });
      expect(await active()).toBe('Open dialog');
      await page.waitForFunction(
        () => document.getElementById('dialog-log')?.textContent === 'Closed 1',
      );
    });

    it('moves tabs with arrow keys, Home and End', async () => {
      await page.locator('#kit-tabs-overview-tab').focus();
      await page.keyboard.press('ArrowRight');
      expect(await active()).toBe('kit-tabs-details-tab');
      expect(await page.locator('#kit-tabs-details-panel').isVisible()).toBe(
        true,
      );
      expect(await page.locator('#kit-tabs-overview-panel').isHidden()).toBe(
        true,
      );
      await page.keyboard.press('End');
      expect(await active()).toBe('kit-tabs-history-tab');
      await page.keyboard.press('Home');
      expect(await active()).toBe('kit-tabs-overview-tab');
      expect(
        await page
          .locator('#kit-tabs-overview-tab')
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('drives the menu from the keyboard and reports value items to the framework', async () => {
      await page.locator('#kit-menu-button').focus();
      await page.keyboard.press('Enter');
      expect(await active()).toBe('Edit');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      expect(await active()).toBe('Archive');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.getElementById('menu-log')?.textContent === 'archive',
      );
      expect(await active()).toBe('kit-menu-button');
      expect(await page.locator('#kit-menu-menu').isHidden()).toBe(true);
      await page.keyboard.press('ArrowUp');
      expect(await active()).toBe('Delete');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      expect(await active()).toBe('kit-menu-button');
      expect(await page.locator('#menu-log').textContent()).toBe('archive');
    });

    it('shows toasts through the component handle', async () => {
      await page.locator('#notify').click();
      const toast = page.locator('#kit-toasts [data-nv-ui-list] .nv-toast');
      await toast.waitFor();
      expect(await toast.locator('.nv-toast__text').textContent()).toBe(
        'Saved',
      );
      await toast.locator('.nv-toast__dismiss').click();
      await toast.waitFor({ state: 'detached' });
    });

    it('formats the date in UTC and reports changes', async () => {
      expect(await page.locator('#kit-due-formatted').textContent()).toBe(
        'March 4, 2026',
      );
      await page.locator('#kit-due').fill('2026-12-25');
      await page.waitForFunction(
        () => document.getElementById('date-log')?.textContent === '2026-12-25',
      );
      expect(await page.locator('#kit-due-formatted').textContent()).toBe(
        'December 25, 2026',
      );
    });

    it('filters, selects and announces data table rows', async () => {
      const visible = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('#kit-table tbody tr')]
            .filter((row) => !(row as HTMLElement).hidden)
            .map((row) => row.querySelector('td:nth-child(2)')?.textContent),
        );
      await page.locator('#kit-table-search').fill('books');
      await page.waitForFunction(
        () =>
          document.getElementById('kit-table-status')?.textContent ===
          '2 results',
      );
      expect(await visible()).toEqual(['Atlas', 'Almanac']);
      await page.locator('#kit-table-search').fill('');
      await page.locator('#kit-table-category').selectOption('tools');
      await page.waitForFunction(() =>
        document
          .getElementById('kit-table-status')
          ?.textContent?.startsWith('1 results'),
      );
      expect(await visible()).toEqual(['Hammer']);
      await page.locator('[data-nv-ui-select-all="kit-table"]').check();
      const values = await page.evaluate(() =>
        new FormData(document.getElementById('bulk') as HTMLFormElement).getAll(
          'ids',
        ),
      );
      expect(values).toEqual(['p2']);
      expect(await page.locator('#kit-table-status').textContent()).toContain(
        '1 selected',
      );
    });

    it('wires form fields for assistive technology and reports edits to the framework', async () => {
      const log = (text: string) =>
        page.waitForFunction(
          (expected) =>
            document.getElementById('field-log')?.textContent === expected,
          text,
        );
      const email = page.getByRole('textbox', { name: 'Email', exact: true });
      await pw(email).toHaveAccessibleDescription(
        'We never share it. Enter a valid email address.',
      );
      await pw(email).toHaveAttribute('aria-invalid', 'true');
      await pw(email).toHaveAttribute('aria-required', 'true');
      await pw(page.getByLabel('Nickname')).toHaveValue('Ada');
      await pw(page.getByLabel('Biography')).toHaveValue('Hello');
      await pw(page.locator('#kit-plan')).toBeChecked();
      await pw(
        page.getByRole('radiogroup', { name: 'Plan' }),
      ).toHaveAccessibleDescription('Change it later.');
      await page.locator('label[for="kit-email"]').click();
      expect(await active()).toBe('kit-email');
      await page.keyboard.type('ada@example.test');
      await log('email:ada@example.test');
      await page.locator('#kit-bio').fill('Hi there');
      await log('bio:Hi there');
      await page.locator('#kit-country').selectOption('fr');
      await log('country:fr');
      await page.locator('label[for="kit-terms"]').click();
      await log('terms:true');
      await page.locator('label[for="kit-plan-2"]').click();
      await log('plan:pro');
      const values = await page.evaluate(() =>
        Object.fromEntries(
          new FormData(
            document.getElementById('kit-profile') as HTMLFormElement,
          ),
        ),
      );
      expect(values).toEqual({
        email: 'ada@example.test',
        nickname: 'Ada',
        bio: 'Hi there',
        country: 'fr',
        terms: 'yes',
        plan: 'pro',
      });
    });

    it('renders charts as named SVG images with data tables, also after remounting', async () => {
      const svgOnly = () =>
        page.evaluate(() => {
          const nodes = [...document.querySelectorAll('#kit-charts svg *')];
          return (
            nodes.length > 0 &&
            nodes.every((node) => node instanceof SVGElement)
          );
        });
      const check = async () => {
        await pw(
          page.getByRole('img', { name: 'Monthly sales' }),
        ).toHaveAccessibleDescription('Online sales peaked in March.');
        await pw(
          page.getByRole('img', { name: 'Weekly visitors' }),
        ).toHaveCount(1);
        await pw(
          page
            .getByRole('table', { name: 'Monthly sales' })
            .getByRole('row', { name: 'Mar 4,500 1,000' }),
        ).toHaveCount(1);
        await pw(page.locator('#kit-trend-data')).toBeVisible();
        const ext = page.getByRole('img', { name: 'Third-party visits' });
        await pw(ext.locator('canvas#kit-ext-chart')).toHaveCount(1);
        expect(await svgOnly()).toBe(true);
        const fill = await page.evaluate(
          () =>
            getComputedStyle(
              document.querySelector('#kit-sales .nv-chart__bar') as Element,
            ).fill,
        );
        expect(fill).toBe('rgb(29, 78, 216)');
      };
      await check();
      // Client-created (not hydrated) SVG must be in the SVG namespace too.
      await page.locator('#toggle').click();
      await page.waitForSelector('#kit', { state: 'detached' });
      await page.locator('#toggle').click();
      await page.waitForSelector('#kit-charts svg');
      await check();
    });

    it('releases behavior on unmount and works once after remounting', async () => {
      await page.locator('#toggle').click();
      await page.waitForSelector('#kit', { state: 'detached' });
      await page.locator('#toggle').click();
      await page.waitForSelector('#kit-tabs [role="tablist"]:not([hidden])');
      await page.locator('#kit-menu-button').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      // One connection set, one controller: the value is reported exactly once.
      await page.waitForFunction(
        () => document.getElementById('menu-log')?.textContent === 'copy',
      );
      await page.locator('[data-nv-ui-open="kit-dialog"]').click();
      await page.waitForSelector('#kit-dialog[open]');
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.getElementById('dialog-log')?.textContent === 'Closed 1',
      );
    });
  });
});
