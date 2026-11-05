import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { UiError, uiHelpers } from '../packages/ui/dist/index.js';

// Server markup contracts for the second UI kit slice. Browser behavior and
// axe checks live in tests/ui-primitives-browser.test.ts.
let root: string;
let engine: HbsEngine;
const templates: Record<string, string> = {
  drawer:
    '{{#uiDrawer id="filters" title=title closeLabel="Close" side=side}}<p>body</p>{{/uiDrawer}}',
  breadcrumbs: '{{uiBreadcrumbs items label="Breadcrumb"}}',
  badge: '{{uiBadge label count=count max=max tone=tone live=live id=id}}',
  alert:
    '{{#uiAlert tone=tone title=title id=id dismissLabel=dismiss live=live}}<p>{{body}}</p>{{/uiAlert}}',
  accordion:
    '{{#uiAccordion id="faq" level=level multiple=multiple}}{{#uiAccordionItem id="a" title="First" open=openA}}<p>A</p>{{/uiAccordionItem}}{{#uiAccordionItem id="b" title="Second" open=openB}}<p>B</p>{{/uiAccordionItem}}{{/uiAccordion}}',
  accordionStray:
    '{{#uiAccordion id="faq"}}stray{{#uiAccordionItem id="a" title="A"}}a{{/uiAccordionItem}}{{/uiAccordion}}',
  accordionOrphan: '{{#uiAccordionItem id="a" title="A"}}a{{/uiAccordionItem}}',
  menu: '{{#uiMenu id="row-actions" label="Actions"}}{{uiMenuItem "Edit" href=link}}{{uiMenuItem "Archive" action=action}}{{uiMenuItem "Copy id" value="copy"}}{{uiMenuItem "Delete" value="delete" disabled=true}}{{/uiMenu}}',
  menuBoth:
    '{{#uiMenu id="m" label="M"}}{{uiMenuItem "X" href="/x" action="y"}}{{/uiMenu}}',
  menuNone: '{{#uiMenu id="m" label="M"}}{{uiMenuItem "X"}}{{/uiMenu}}',
  popover:
    '{{#uiPopover id="help" label="Help" title=title}}<p>{{body}}</p>{{/uiPopover}}',
  tooltip:
    '{{#uiTooltip id="tip" text=tip label=label}}{{{content}}}{{/uiTooltip}}',
  date: '{{uiDatePicker id="due" name="due" label="Due date" value=value min=min max=max locale=locale dateStyle=style model=model required=true}}',
  upload:
    '{{uiFileUpload id="files" name="files" label="Attachments" accept=accept multiple=true model=model hint="PNG or PDF" dropLabel="Drop files here" selectedLabel="{count} files selected" progressLabel="Upload progress" cancelLabel="Cancel upload"}}',
  wizard:
    '{{#uiWizard id="setup" label="Setup steps" current=current stepLabel="Step {step} of {total}" completedLabel="completed"}}{{#uiWizardStep id="account" title="Account" href="/setup/account"}}<p>account body</p>{{/uiWizardStep}}{{#uiWizardStep id="profile" title="Profile"}}<p>profile body</p>{{/uiWizardStep}}{{#uiWizardStep id="done" title="Done"}}<p>done body</p>{{/uiWizardStep}}{{/uiWizard}}',
  wizardOne:
    '{{#uiWizard id="w" label="L" current="a" stepLabel="S" completedLabel="c"}}{{#uiWizardStep id="a" title="A"}}a{{/uiWizardStep}}{{/uiWizard}}',
  table:
    '{{#uiDataTable id="products" caption="Products" selectionLabel="{count} selected"}}<thead><tr>{{uiSelectAll table="products" label="Select all products"}}<th>Name</th></tr></thead><tbody><tr data-category="books">{{uiSelectRow name="ids" value="p1" label="Select Atlas" checked=true}}<td>Atlas</td></tr></tbody>{{/uiDataTable}}',
  search:
    '{{uiTableSearch table="products" label="Search products" client=client model=model name=name value=value resultsLabel=results}}',
  filter:
    '{{uiTableFilter table="products" key=key label="Category" allLabel="All categories" options=options value=value client=client model=model resultsLabel="{count} results"}}',
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nestvexa-ui-primitives-'));
  for (const [name, source] of Object.entries(templates))
    await writeFile(join(root, `${name}.hbs`), source);
  engine = new HbsEngine({ root });
  engine.registerHelpers(uiHelpers());
  await engine.initialize();
});
afterAll(async () => {
  await engine.dispose();
  await rm(root, { recursive: true, force: true });
});
const render = (view: string, model: Record<string, unknown> = {}) =>
  engine.render(view, model);
async function failure(
  view: string,
  model: Record<string, unknown>,
): Promise<unknown> {
  try {
    await render(view, model);
  } catch (error) {
    return error instanceof Error && error.cause !== undefined
      ? error.cause
      : error;
  }
  throw new Error('Expected rendering to fail');
}

describe('drawer', () => {
  it('renders a side-anchored modal dialog that reuses the dialog behavior', async () => {
    const html = await render('drawer', { title: 'Filters', side: 'start' });
    expect(html).toContain(
      '<dialog id="filters" class="nv-dialog nv-drawer" data-nv-ui="dialog" data-nv-ui-variant="drawer" data-side="start" aria-labelledby="filters-title">',
    );
    expect(await render('drawer', { title: 'Filters' })).toContain(
      'data-side="end"',
    );
    expect(
      await failure('drawer', { title: 'Filters', side: 'left' }),
    ).toBeInstanceOf(UiError);
  });
});

describe('breadcrumbs', () => {
  it('renders an ordered trail with aria-current on the last item', async () => {
    const html = await render('breadcrumbs', {
      items: [
        { label: 'Home', href: '/' },
        { label: 'Products <b>', href: '/products' },
        { label: 'Atlas' },
      ],
    });
    expect(html).toBe(
      '<nav class="nv-breadcrumbs" aria-label="Breadcrumb"><ol class="nv-breadcrumbs__list"><li class="nv-breadcrumbs__item"><a href="/" class="nv-breadcrumbs__link">Home</a></li><li class="nv-breadcrumbs__item"><a href="/products" class="nv-breadcrumbs__link">Products &lt;b&gt;</a></li><li class="nv-breadcrumbs__item"><span class="nv-breadcrumbs__current" aria-current="page">Atlas</span></li></ol></nav>',
    );
    expect(
      await render('breadcrumbs', {
        items: [{ label: 'Here', href: '/here' }],
      }),
    ).toContain(
      '<a href="/here" class="nv-breadcrumbs__link" aria-current="page">',
    );
  });
  it('rejects unsafe links, missing links before the end and extra keys', async () => {
    for (const items of [
      [{ label: 'X', href: 'javascript:alert(1)' }, { label: 'Y' }],
      [{ label: 'X' }, { label: 'Y' }],
      [{ label: 'X', href: '/', onclick: 'y' }],
      [],
      Array.from({ length: 17 }, () => ({ label: 'x', href: '/' })),
    ])
      expect(await failure('breadcrumbs', { items })).toBeInstanceOf(UiError);
  });
});

describe('badge', () => {
  it('renders text badges and accessible count badges', async () => {
    expect(await render('badge', { label: 'Beta', tone: 'info' })).toBe(
      '<span class="nv-badge" data-tone="info">Beta</span>',
    );
    expect(
      await render('badge', {
        label: '{count} unread notifications',
        count: 120,
        live: true,
        id: 'unread',
      }),
    ).toBe(
      '<span id="unread" class="nv-badge" data-tone="neutral" role="status"><span class="nv-badge__count" aria-hidden="true">99+</span><span class="nv-visually-hidden">120 unread notifications</span></span>',
    );
    expect(
      await render('badge', { label: '{count} new', count: 3, max: 9 }),
    ).toContain('aria-hidden="true">3</span>');
  });
  it('rejects unknown tones and invalid counts', async () => {
    expect(await failure('badge', { label: 'x', tone: 'red' })).toBeInstanceOf(
      UiError,
    );
    for (const count of [-1, 1.5, '3', 2_000_000_000])
      expect(await failure('badge', { label: 'x', count })).toBeInstanceOf(
        UiError,
      );
  });
});

describe('alert', () => {
  it('chooses alert or status roles by tone and escapes the title', async () => {
    const danger = await render('alert', {
      tone: 'danger',
      title: 'Save <failed>',
      id: 'save-error',
      body: 'Try again',
      dismiss: 'Dismiss',
    });
    expect(danger).toContain(
      '<div id="save-error" class="nv-alert" data-nv-ui="alert" data-tone="danger" role="alert" aria-labelledby="save-error-title">',
    );
    expect(danger).toContain('Save &lt;failed&gt;');
    expect(danger).toContain(
      '<button type="button" class="nv-alert__dismiss" data-nv-ui-dismiss hidden aria-label="Dismiss">',
    );
    expect(await render('alert', { tone: 'success', body: 'ok' })).toContain(
      'role="status"',
    );
    expect(
      await render('alert', { tone: 'warning', body: 'x', live: false }),
    ).not.toContain('role=');
    expect(await failure('alert', { tone: 'fatal' })).toBeInstanceOf(UiError);
  });
});

describe('accordion', () => {
  it('renders APG heading buttons and labelled progressive panels', async () => {
    const html = await render('accordion', { openA: true });
    expect(html).toContain(
      '<h3 class="nv-accordion__heading"><button type="button" class="nv-accordion__trigger" id="faq-a-trigger" aria-expanded="true" aria-controls="faq-a-panel">First',
    );
    expect(html).toContain(
      '<div class="nv-accordion__panel" id="faq-a-panel" role="region" aria-labelledby="faq-a-trigger"><p>A</p></div>',
    );
    expect(html).toContain(
      '<div class="nv-accordion__panel" id="faq-b-panel" role="region" aria-labelledby="faq-b-trigger" data-nv-ui-collapsed><p>B</p></div>',
    );
    expect(html).not.toContain(' hidden');
    expect(await render('accordion', { level: 2 })).toContain('<h2 ');
  });
  it('enforces item structure, single-open mode and heading levels', async () => {
    expect(
      await failure('accordion', { openA: true, openB: true }),
    ).toBeInstanceOf(UiError);
    expect(
      await render('accordion', { openA: true, openB: true, multiple: true }),
    ).toContain('data-nv-ui-multiple');
    expect(await failure('accordion', { level: 1 })).toBeInstanceOf(UiError);
    expect(await failure('accordionStray', {})).toBeInstanceOf(UiError);
    expect(await failure('accordionOrphan', {})).toBeInstanceOf(UiError);
  });
});

describe('menu button', () => {
  it('renders the APG menu button pattern with links, actions and values', async () => {
    const html = await render('menu', {
      link: '/products/1',
      action: 'archive',
    });
    expect(html).toContain(
      '<button type="button" class="nv-button nv-menu__button" id="row-actions-button" aria-haspopup="menu" aria-expanded="false" aria-controls="row-actions-menu">Actions',
    );
    expect(html).toContain(
      '<ul role="menu" class="nv-menu__list" id="row-actions-menu" aria-labelledby="row-actions-button" data-nv-ui-collapsed>',
    );
    expect(html).toContain(
      '<li role="none"><a role="menuitem" class="nv-menu__item" href="/products/1">Edit</a></li>',
    );
    expect(html).toContain(
      '<button role="menuitem" class="nv-menu__item" type="button" nv:click="archive">Archive</button>',
    );
    expect(html).toContain('data-nv-ui-value="copy"');
    // Disabled items keep their place but lose their action.
    expect(html).toContain(
      '<button role="menuitem" class="nv-menu__item" aria-disabled="true" type="button" data-nv-ui-value="delete">Delete</button>',
    );
  });
  it('requires exactly one target and rejects expression-like actions', async () => {
    expect(await failure('menuBoth', {})).toBeInstanceOf(UiError);
    expect(await failure('menuNone', {})).toBeInstanceOf(UiError);
    expect(
      await failure('menu', { link: '/x', action: 'archive()' }),
    ).toBeInstanceOf(UiError);
    expect(
      await failure('menu', { link: '//evil.example', action: 'a' }),
    ).toBeInstanceOf(UiError);
  });
});

describe('popover and tooltip', () => {
  it('renders a non-modal dialog disclosed by a button', async () => {
    const html = await render('popover', { title: 'About <x>', body: 'b' });
    expect(html).toContain(
      '<button type="button" class="nv-button nv-popover__trigger" id="help-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="help-panel">Help</button>',
    );
    expect(html).toContain(
      '<div class="nv-popover__panel" id="help-panel" role="dialog" aria-labelledby="help-title" data-nv-ui-collapsed><p class="nv-popover__title" id="help-title">About &lt;x&gt;</p>',
    );
    expect(await render('popover', { body: 'b' })).toContain(
      'aria-labelledby="help-trigger"',
    );
  });
  it('describes the trigger with a role=tooltip element and requires a name', async () => {
    const html = await render('tooltip', {
      tip: 'Prices include <VAT>',
      label: 'Price help',
      content: '<span aria-hidden="true">?</span>',
    });
    expect(html).toBe(
      '<span class="nv-tooltip" data-nv-ui="tooltip"><button type="button" class="nv-tooltip__trigger" aria-label="Price help" aria-describedby="tip"><span aria-hidden="true">?</span></button><span role="tooltip" id="tip" class="nv-tooltip__bubble" hidden>Prices include &lt;VAT&gt;</span></span>',
    );
    expect(
      await failure('tooltip', {
        tip: 'x',
        content: '<span aria-hidden="true"></span>',
      }),
    ).toBeInstanceOf(UiError);
    expect(await render('tooltip', { tip: 'x', content: 'Help' })).toContain(
      '>Help</button>',
    );
  });
});

describe('date picker', () => {
  it('renders a native date input with a locale-formatted UTC output', async () => {
    const html = await render('date', {
      value: '2026-03-01',
      min: '2026-01-01',
      max: '2026-12-31',
      locale: 'en-US',
    });
    expect(html).toContain(
      '<input id="due" class="nv-date__input" type="date" name="due" value="2026-03-01" min="2026-01-01" max="2026-12-31" required aria-describedby="due-formatted">',
    );
    // UTC formatting: no time zone can shift a date-only value to Feb 28.
    expect(html).toContain(
      '<output class="nv-date__formatted" id="due-formatted" for="due" aria-live="polite">March 1, 2026</output>',
    );
    const arabic = await render('date', {
      value: '2026-03-01',
      locale: 'ar-EG',
      style: 'full',
    });
    expect(arabic).toContain('data-nv-ui-locale="ar-EG"');
    expect(arabic).toContain(
      new Intl.DateTimeFormat('ar-EG', {
        dateStyle: 'full',
        timeZone: 'UTC',
      }).format(new Date('2026-03-01T00:00:00Z')),
    );
  });
  it('mirrors into a hidden text model input for Live', async () => {
    const html = await render('date', { value: '2026-03-01', model: 'due' });
    expect(html).toContain(
      '<input type="text" id="due-value" name="due" value="2026-03-01" hidden tabindex="-1" autocomplete="off" data-nv-ui-date-value nv:model.change="due">',
    );
    expect(html).not.toMatch(/type="date" name=/);
  });
  it.each([
    [{ value: '2026-02-30' }],
    [{ value: '2026-3-1' }],
    [{ value: '2026-03-01T00:00' }],
    [{ min: '2026-05-01', max: '2026-01-01' }],
    [{ value: '2027-01-01', max: '2026-12-31' }],
    [{ locale: 'not a locale!' }],
    [{ style: 'huge' }],
  ])('rejects invalid date input %j', async (model) => {
    expect(await failure('date', model)).toBeInstanceOf(UiError);
  });
});

describe('file uploader', () => {
  it('renders a named native input for multipart forms', async () => {
    const html = await render('upload', { accept: '.png, application/pdf' });
    expect(html).toContain(
      '<input id="files" class="nv-upload__input" type="file" name="files" accept=".png,application/pdf" multiple aria-describedby="files-hint files-selection">',
    );
    expect(html).toContain(
      '<div class="nv-upload__drop" data-nv-ui-drop hidden>Drop files here</div>',
    );
    expect(html).toContain(
      '<p class="nv-upload__selection" id="files-selection" role="status" data-nv-ui-upload-status></p>',
    );
    expect(html).not.toContain('nv:upload');
  });
  it('emits the Live upload directives with a model', async () => {
    const html = await render('upload', { model: 'attachments' });
    expect(html).toContain('nv:upload="attachments"');
    expect(html).toContain('nv:upload.progress="attachments"');
    expect(html).toContain('nv:upload.status="attachments"');
    expect(html).toContain('nv:upload.cancel="attachments">Cancel upload');
    expect(html).toContain(
      'aria-describedby="files-hint files-selection files-status"',
    );
    expect(html).not.toMatch(/type="file" name=/);
  });
  it('rejects unsafe accept tokens and models', async () => {
    for (const accept of ['"><x', '.png;rm', 'image/*,' + 'a'.repeat(600)])
      expect(await failure('upload', { accept })).toBeInstanceOf(UiError);
    expect(await failure('upload', { model: 'a.b' })).toBeInstanceOf(UiError);
  });
});

describe('wizard', () => {
  it('renders step state, aria-current and only the current body', async () => {
    const html = await render('wizard', { current: 'profile' });
    expect(html).toContain('data-nv-ui-current="profile"');
    expect(html).toContain(
      '<li class="nv-wizard__step" data-state="complete"><span class="nv-wizard__number" aria-hidden="true">1</span><a class="nv-wizard__link" href="/setup/account">Account</a><span class="nv-visually-hidden"> (completed)</span></li>',
    );
    expect(html).toContain(
      '<li class="nv-wizard__step" data-state="current" aria-current="step">',
    );
    expect(html).toContain('data-state="upcoming"');
    expect(html).toContain(
      '<h2 class="nv-wizard__heading" id="setup-heading" tabindex="-1">Step 2 of 3: Profile</h2><p>profile body</p>',
    );
    expect(html).not.toContain('account body');
    expect(html).not.toContain('done body');
  });
  it('requires a known current step and at least two steps', async () => {
    expect(await failure('wizard', { current: 'missing' })).toBeInstanceOf(
      UiError,
    );
    expect(await failure('wizardOne', {})).toBeInstanceOf(UiError);
  });
});

describe('data table', () => {
  it('renders a captioned table, selection checkboxes and a status line', async () => {
    const html = await render('table');
    expect(html).toContain(
      '<div class="nv-data-table" data-nv-ui="data-table" data-nv-ui-selection-label="{count} selected"><table id="products" class="nv-table" aria-describedby="products-status"><caption class="nv-table__caption">Products</caption>',
    );
    expect(html).toContain(
      '<th scope="col" class="nv-table__select"><input type="checkbox" class="nv-table__checkbox" aria-label="Select all products" aria-controls="products" data-nv-ui-select-all="products"></th>',
    );
    expect(html).toContain(
      '<td class="nv-table__select"><input type="checkbox" class="nv-table__checkbox" name="ids" value="p1" checked aria-label="Select Atlas" data-nv-ui-select-row></td>',
    );
  });
  it('wires search for client filtering, a Live model or a GET form', async () => {
    const client = await render('search', {
      client: true,
      results: '{count} results',
    });
    expect(client).toContain('role="search"');
    expect(client).toContain(
      'type="search" value="" autocomplete="off" aria-controls="products" data-nv-ui-filter-table="products" data-nv-ui-results-label="{count} results">',
    );
    const live = await render('search', { model: 'query', value: 'atl' });
    expect(live).toContain('nv:model.live.debounce.300ms="query"');
    expect(live).not.toContain('data-nv-ui-filter-table');
    expect(await render('search', { name: 'q' })).toContain('name="q"');
    expect(
      await failure('search', { client: true, model: 'query', results: 'x' }),
    ).toBeInstanceOf(UiError);
    expect(await failure('search', { client: true })).toBeInstanceOf(UiError);
  });
  it('renders select filters with validated keys and options', async () => {
    const options = [
      { value: 'books', label: 'Books' },
      { value: 'tools', label: 'Tools' },
    ];
    const html = await render('filter', {
      key: 'category',
      options,
      value: 'tools',
      client: true,
    });
    expect(html).toContain(
      '<select id="products-category" class="nv-table-filter__select" aria-controls="products" data-nv-ui-filter-table="products" data-nv-ui-filter-key="category" data-nv-ui-results-label="{count} results">',
    );
    expect(html).toContain('<option value="tools" selected>Tools</option>');
    expect(
      await render('filter', { key: 'category', options, model: 'category' }),
    ).toContain('nv:model.change="category"');
    for (const model of [
      { key: 'Category', options },
      { key: 'a"b', options },
      { key: 'category', options, value: 'garden' },
      { key: 'category', options: [...options, options[0]] },
      { key: 'category', options: [{ value: 'x', label: 'X', extra: 1 }] },
    ])
      expect(await failure('filter', model)).toBeInstanceOf(UiError);
  });
});

describe('theme tokens', () => {
  it('ships tokens.css identical to the token block of theme.css', async () => {
    const tokens = await readFile('packages/ui/theme/tokens.css', 'utf8');
    const theme = await readFile('packages/ui/theme/theme.css', 'utf8');
    const block = (source: string) =>
      source.slice(
        source.indexOf(':root {'),
        source.indexOf('.nv-visually-hidden'),
      );
    const tokenBlock = tokens.slice(tokens.indexOf(':root {')).trim();
    expect(block(theme).trim()).toBe(tokenBlock);
    expect(tokenBlock).not.toMatch(/\.nv-/);
  });
});
