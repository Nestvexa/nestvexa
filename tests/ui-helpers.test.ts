import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { errorSummary, fieldView } from '../packages/forms/dist/index.js';
import { UiError, escapeHtml, uiHelpers } from '../packages/ui/dist/index.js';

let root: string;
let engine: HbsEngine;
const templates: Record<string, string> = {
  dialog:
    '{{#uiDialog id=id title=title closeLabel="Close" describedBy=described closeOn=closeOn}}<p id="d-desc">{{body}}</p>{{/uiDialog}}',
  trigger: '{{uiDialogTrigger target label=label href=href class=klass}}',
  tabs: '{{#uiTabs id="admin" label=label}}{{#uiTab id="one" label=first}}<p>{{content}}</p>{{/uiTab}}{{#uiTab id="two" label="Two" selected=pickTwo}}<p>two</p>{{/uiTab}}{{/uiTabs}}',
  tabsEach:
    '{{#uiTabs id="dyn" label="Dynamic"}}{{#each items}}{{#uiTab id=this.id label=this.label}}{{this.label}}{{/uiTab}}{{/each}}{{/uiTabs}}',
  tabsDuplicate:
    '{{#uiTabs id="d" label="L"}}{{#uiTab id="a" label="A"}}a{{/uiTab}}{{#uiTab id="a" label="B"}}b{{/uiTab}}{{/uiTabs}}',
  tabsStray:
    '{{#uiTabs id="d" label="L"}}stray{{#uiTab id="a" label="A"}}a{{/uiTab}}{{/uiTabs}}',
  tabOrphan: '{{#uiTab id="a" label="A"}}a{{/uiTab}}',
  combobox:
    '{{uiCombobox id="category" name="category" label=label options=options value=value emptyLabel="No matches" countLabel="{count} results" model=model placeholder="Search"}}',
  toasts:
    '{{uiToastRegion id="toasts" label="Notifications" dismissLabel="Dismiss" messages=messages}}',
  sort: '<table><thead><tr>{{uiSortHeader label="Name" key="name" sort=sort direction=direction action=action}}{{uiSortHeader label="Price" key="price" sort=sort direction=direction href=href}}</tr></thead></table>',
  pagination:
    '{{uiPagination pagination label="Pagination" previousLabel="Previous" nextLabel="Next" pageLabel="Page {page}" href=href navigate=true}}',
  disclosure:
    '{{#uiDisclosure summary=summary open=true}}<p>{{body}}</p>{{/uiDisclosure}}',
  progress:
    '{{uiProgress id="import" label="Import" value=value max=100 valueText=valueText}}',
  hidden: '{{uiVisuallyHidden text}}',
  textField:
    '{{uiTextField id=id name=name label=label type=type hint=hint error=error field=field required=required disabled=disabled readOnly=readOnly model=model modelModifiers=modifiers value=value placeholder=placeholder autocomplete=autocomplete minLength=minLength maxLength=maxLength describedBy=describedBy class=klass}}',
  textareaField:
    '{{uiTextareaField id="bio" name="bio" label="Biography" rows=rows value=value error=error maxLength=500}}',
  selectField:
    '{{uiSelectField id="country" name="country" label="Country" options=options value=value placeholder=placeholder required=true model=model modelModifiers="change" error=error}}',
  checkboxField:
    '{{uiCheckboxField id="terms" name="terms" label=label value="yes" checked=checked required=true error=error hint="Required to continue"}}',
  radioField:
    '{{uiRadioGroupField id="plan" name=name label="Plan" options=options value=value required=required error=error hint=hint model=model field=field}}',
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nestvexa-ui-'));
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

describe('uiHelpers registration', () => {
  it('exposes the documented helper names and supports a prefix', () => {
    expect(Object.keys(uiHelpers()).sort()).toEqual(
      [
        'uiCombobox',
        'uiDialog',
        'uiDialogTrigger',
        'uiDisclosure',
        'uiPagination',
        'uiProgress',
        'uiSortHeader',
        'uiTab',
        'uiTabs',
        'uiToastRegion',
        'uiVisuallyHidden',
        'uiDrawer',
        'uiBreadcrumbs',
        'uiBadge',
        'uiAlert',
        'uiAccordion',
        'uiAccordionItem',
        'uiMenu',
        'uiMenuItem',
        'uiPopover',
        'uiTooltip',
        'uiDatePicker',
        'uiFileUpload',
        'uiWizard',
        'uiWizardStep',
        'uiDataTable',
        'uiTableSearch',
        'uiTableFilter',
        'uiSelectAll',
        'uiSelectRow',
        'uiTextField',
        'uiTextareaField',
        'uiSelectField',
        'uiCheckboxField',
        'uiRadioGroupField',
        'uiChart',
      ].sort(),
    );
    expect(Object.keys(uiHelpers({ prefix: 'kit' }))).toContain('kitDialog');
    expect(Object.isFrozen(uiHelpers())).toBe(true);
    for (const prefix of ['nv', 'Ui', '1x', 'a-b', 'x'.repeat(20)])
      expect(() => uiHelpers({ prefix })).toThrow(UiError);
  });
  it('rejects a second registration of the same names', () => {
    const second = new HbsEngine({ root, helpers: { uiDialog: () => '' } });
    expect(() => second.registerHelpers(uiHelpers())).toThrow(/Duplicate/);
  });
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>\`=&`)).toBe(
      '&lt;a href&#61;&quot;x&quot; onclick&#61;&#39;y&#39;&gt;&#96;&#61;&amp;',
    );
  });
});

describe('dialog', () => {
  it('renders a labelled native dialog with escaped text and trusted body', async () => {
    const html = await render('dialog', {
      id: 'confirm',
      title: '<img src=x onerror=alert(1)>',
      body: '<script>x</script>',
      described: 'd-desc',
      closeOn: 'product-created',
    });
    expect(html).toContain(
      '<dialog id="confirm" class="nv-dialog" data-nv-ui="dialog" aria-labelledby="confirm-title" aria-describedby="d-desc" data-nv-ui-close-on="product-created">',
    );
    expect(html).toContain('<h2 class="nv-dialog__title" id="confirm-title">');
    expect(html).toContain('&lt;img src&#61;x onerror&#61;alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain(
      '<button type="button" class="nv-dialog__close" data-nv-ui-close aria-label="Close">',
    );
  });
  it.each([['1bad'], ['a b'], ['"><script>'], ['__proto__'], ['x'.repeat(65)]])(
    'rejects the unsafe id %s',
    async (id) => {
      expect(await failure('dialog', { id, title: 'T' })).toBeInstanceOf(
        UiError,
      );
    },
  );
  it('requires a title and an identifier-safe closeOn event', async () => {
    expect(await failure('dialog', { id: 'd' })).toBeInstanceOf(UiError);
    expect(
      await failure('dialog', { id: 'd', title: 'T', closeOn: 'a()' }),
    ).toBeInstanceOf(UiError);
  });
});

describe('dialog trigger', () => {
  it('renders a button or a progressive-enhancement link', async () => {
    expect(await render('trigger', { target: 'confirm', label: 'Open' })).toBe(
      '<button type="button" class="nv-button" data-nv-ui-open="confirm" aria-haspopup="dialog" aria-controls="confirm">Open</button>',
    );
    expect(
      await render('trigger', {
        target: 'confirm',
        label: 'Open',
        href: '/products/new?x=1',
        klass: 'primary wide',
      }),
    ).toBe(
      '<a href="/products/new?x&#61;1" role="button" class="nv-button primary wide" data-nv-ui-open="confirm" aria-haspopup="dialog" aria-controls="confirm">Open</a>',
    );
  });
  it.each([
    'javascript:alert(1)',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '/ok\nSet-Cookie: x',
    'relative',
  ])('rejects the unsafe href %s', async (href) => {
    expect(
      await failure('trigger', { target: 'confirm', label: 'Open', href }),
    ).toBeInstanceOf(UiError);
  });
  it('rejects class injection', async () => {
    expect(
      await failure('trigger', {
        target: 'confirm',
        label: 'Open',
        klass: 'a" onclick="x',
      }),
    ).toBeInstanceOf(UiError);
  });
});

describe('tabs', () => {
  it('renders APG tabs with one selected tab and progressive panels', async () => {
    const html = await render('tabs', {
      label: 'Admin',
      first: 'One <b>',
      content: '<i>x</i>',
    });
    expect(html).toContain(
      '<div class="nv-tabs__list" role="tablist" hidden aria-label="Admin">',
    );
    expect(html).toContain(
      '<button type="button" role="tab" class="nv-tabs__tab" id="admin-one-tab" aria-controls="admin-one-panel" aria-selected="true" tabindex="0">One &lt;b&gt;</button>',
    );
    expect(html).toContain('aria-selected="false" tabindex="-1">Two</button>');
    expect(html).toContain(
      '<div role="tabpanel" class="nv-tabs__panel" id="admin-one-panel" aria-labelledby="admin-one-tab" tabindex="0"><p>&lt;i&gt;x&lt;/i&gt;</p></div>',
    );
    // Inactive panels are never `hidden` on the server: no-JS users see them.
    expect(html).toContain(
      'id="admin-two-panel" aria-labelledby="admin-two-tab" tabindex="0" data-nv-ui-inactive>',
    );
    expect(html).not.toMatch(/tabpanel[^>]*hidden/);
  });
  it('honours an explicit selection and works inside #each frames', async () => {
    const html = await render('tabs', {
      label: 'Admin',
      first: 'One',
      pickTwo: true,
    });
    expect(html).toContain(
      'id="admin-two-tab" aria-controls="admin-two-panel" aria-selected="true"',
    );
    const dynamic = await render('tabsEach', {
      items: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
    });
    expect(dynamic.match(/role="tab"/g)).toHaveLength(2);
  });
  it('rejects duplicate ids, stray content, orphan tabs and selection overflow', async () => {
    expect(await failure('tabsDuplicate', {})).toBeInstanceOf(UiError);
    expect(await failure('tabsStray', {})).toBeInstanceOf(UiError);
    expect(await failure('tabOrphan', {})).toBeInstanceOf(UiError);
    expect(
      await failure('tabsEach', {
        items: [{ id: 'bad id', label: 'X' }],
      }),
    ).toBeInstanceOf(UiError);
  });
});

describe('combobox', () => {
  const options = [
    { value: 'books', label: 'Books' },
    { value: 'tools', label: 'Tools & <hardware>' },
  ];
  it('renders the editable combobox contract with a committed hidden value', async () => {
    const html = await render('combobox', {
      label: 'Category',
      options,
      value: 'tools',
      model: 'category',
    });
    expect(html).toContain(
      '<input id="category" class="nv-combobox__input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="category-listbox" autocomplete="off" spellcheck="false" placeholder="Search" value="Tools &amp; &lt;hardware&gt;">',
    );
    expect(html).toContain(
      '<input type="text" id="category-value" name="category" value="tools" hidden tabindex="-1" autocomplete="off" data-nv-ui-value nv:model="category">',
    );
    expect(html).toContain(
      '<ul role="listbox" class="nv-combobox__listbox" id="category-listbox" aria-label="Category" hidden>',
    );
    expect(html).toContain(
      '<li role="option" class="nv-combobox__option" id="category-opt-1" data-value="tools" aria-selected="true">Tools &amp; &lt;hardware&gt;</li>',
    );
    expect(html).not.toContain('type="hidden" id="category-value"');
    const plain = await render('combobox', {
      label: 'Category',
      options,
      value: 'tools',
    });
    expect(plain).toContain(
      '<input type="hidden" id="category-value" name="category" value="tools" data-nv-ui-value>',
    );
    expect(html).toContain('data-nv-ui-count-label="{count} results"');
    expect(html).toContain('role="status" data-nv-ui-status');
  });
  it('rejects unknown values, duplicate values, model injection and prototype keys', async () => {
    expect(
      await failure('combobox', { label: 'C', options, value: 'nope' }),
    ).toBeInstanceOf(UiError);
    expect(
      await failure('combobox', {
        label: 'C',
        options: [options[0], options[0]],
      }),
    ).toBeInstanceOf(UiError);
    expect(
      await failure('combobox', { label: 'C', options, model: 'a" x="' }),
    ).toBeInstanceOf(UiError);
    expect(
      await failure('combobox', {
        label: 'C',
        options: [{ value: 'a', label: 'A', extra: 'x' }],
      }),
    ).toBeInstanceOf(UiError);
    // The engine refuses prototype keys before any helper can see them.
    const polluted = JSON.parse(
      '[{"value":"a","label":"A","__proto__":{"admin":true}}]',
    ) as unknown;
    await expect(
      render('combobox', { label: 'C', options: polluted }),
    ).rejects.toThrow();
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
    expect(
      await failure('combobox', {
        label: 'C',
        options: Array.from({ length: 501 }, (_, index) => ({
          value: `v${index}`,
          label: `L${index}`,
        })),
      }),
    ).toBeInstanceOf(UiError);
  });
});

describe('toast region', () => {
  it('renders polite and assertive live regions with escaped initial messages', async () => {
    const html = await render('toasts', {
      messages: ['Saved <img src=x onerror=alert(1)>'],
    });
    expect(html).toContain(
      '<section class="nv-toasts" data-nv-ui="toasts" id="toasts" aria-label="Notifications" data-nv-ui-event="toast" data-nv-ui-dismiss-label="Dismiss">',
    );
    expect(html).toContain(
      'role="status" aria-live="polite" aria-atomic="false"',
    );
    expect(html).toContain('role="alert" aria-live="assertive"');
    expect(html).toContain('Saved &lt;img src&#61;x onerror&#61;alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('sortable headers', () => {
  it('sets aria-sort only on the sorted column', async () => {
    const html = await render('sort', {
      sort: 'name',
      direction: 'desc',
      action: 'sortByName',
      href: '/products?sort=price',
    });
    expect(html).toContain(
      '<th scope="col" aria-sort="descending"><button type="button" class="nv-sort" nv:click="sortByName" data-nv-ui-sort-key="name">Name<span class="nv-sort__icon" aria-hidden="true">▼</span></button></th>',
    );
    expect(html).toContain(
      '<th scope="col"><a class="nv-sort" href="/products?sort&#61;price" data-nv-ui-sort-key="price">Price<span class="nv-sort__icon" aria-hidden="true">↕</span></a></th>',
    );
    expect(html.match(/aria-sort/g)).toHaveLength(1);
  });
  it.each(["sortBy');alert(1)//", 'sortBy(name)', '__proto__', 'a b'])(
    'rejects the action injection %s',
    async (action) => {
      expect(
        await failure('sort', { sort: 'name', action, href: '/x' }),
      ).toBeInstanceOf(UiError);
    },
  );
  it('rejects an unknown direction', async () => {
    expect(
      await failure('sort', {
        sort: 'name',
        direction: 'sideways',
        action: 'sortByName',
        href: '/x',
      }),
    ).toBeInstanceOf(UiError);
  });
});

describe('pagination', () => {
  const pagination = {
    page: 2,
    perPage: 10,
    total: 90,
    pages: 9,
    offset: 10,
    from: 11,
    to: 20,
    hasPrevious: true,
    hasNext: true,
    previous: 1,
    next: 3,
    links: [
      { page: 1, current: false, gap: false },
      { page: 2, current: true, gap: false },
      { page: 3, current: false, gap: false },
      { page: null, current: false, gap: true },
      { page: 9, current: false, gap: false },
    ],
  };
  it('renders a navigation landmark with aria-current and hidden gaps', async () => {
    const html = await render('pagination', {
      pagination,
      href: '/products?page=',
    });
    expect(html).toContain(
      '<nav class="nv-pagination" aria-label="Pagination">',
    );
    expect(html).toContain(
      '<a href="/products?page&#61;2" nv:navigate aria-label="Page 2" aria-current="page">2</a>',
    );
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).toContain(
      '<li class="nv-pagination__gap" aria-hidden="true">…</li>',
    );
    expect(html).toContain('rel="prev">Previous</a>');
  });
  it('renders disabled edges as non-links and rejects bad input', async () => {
    const html = await render('pagination', {
      pagination: { ...pagination, page: 1, previous: null },
      href: '/p?page=',
    });
    expect(html).toContain(
      '<span class="nv-pagination__disabled" aria-disabled="true">Previous</span>',
    );
    expect(
      await failure('pagination', { pagination, href: 'javascript:x' }),
    ).toBeInstanceOf(UiError);
    expect(
      await failure('pagination', {
        pagination: { ...pagination, links: [{ page: 99, gap: false }] },
        href: '/p?page=',
      }),
    ).toBeInstanceOf(UiError);
    expect(
      await failure('pagination', { pagination: 'x', href: '/p' }),
    ).toBeInstanceOf(UiError);
  });
});

describe('disclosure, progress and visually hidden text', () => {
  it('uses native details/summary and progress semantics', async () => {
    expect(
      await render('disclosure', { summary: 'More <b>', body: '<x>' }),
    ).toBe(
      '<details class="nv-disclosure" open><summary class="nv-disclosure__summary">More &lt;b&gt;</summary><div class="nv-disclosure__body"><p>&lt;x&gt;</p></div></details>',
    );
    expect(
      await render('progress', { value: 40, valueText: '40 of 100' }),
    ).toBe(
      '<div class="nv-progress"><label class="nv-progress__label" for="import">Import</label><progress id="import" class="nv-progress__bar" max="100" value="40" aria-valuetext="40 of 100"></progress></div>',
    );
    expect(await render('progress', {})).toContain(
      '<progress id="import" class="nv-progress__bar" max="100"></progress>',
    );
    expect(await failure('progress', { value: 101 })).toBeInstanceOf(UiError);
    expect(await failure('progress', { value: -1 })).toBeInstanceOf(UiError);
    expect(await render('hidden', { text: '<b>x</b>' })).toBe(
      '<span class="nv-visually-hidden">&lt;b&gt;x&lt;/b&gt;</span>',
    );
  });
});

describe('form field wrappers', () => {
  const email = { id: 'email', name: 'email', label: 'Email', type: 'email' };
  const plans = [
    { value: 'basic', label: 'Basic' },
    { value: 'pro', label: 'Pro' },
    { value: 'team', label: 'Team', disabled: true },
  ];
  it('wires label, hint, error, aria-invalid, aria-describedby and required', async () => {
    expect(
      await render('textField', {
        ...email,
        hint: 'We never share it.',
        error: 'Enter a valid email address.',
        required: true,
        autocomplete: 'email',
      }),
    ).toBe(
      '<div class="nv-field nv-field--input" data-invalid><label class="nv-field__label" for="email">Email<span class="nv-field__required" aria-hidden="true">*</span></label><p class="nv-field__hint" id="email-hint">We never share it.</p><input id="email" class="nv-field__control" type="email" autocomplete="email" name="email" required aria-required="true" aria-invalid="true" aria-describedby="email-hint email-error"><div class="nv-field__error" id="email-error" role="alert"><p class="nv-field__message">Enter a valid email address.</p></div></div>',
    );
    const valid = await render('textField', {
      ...email,
      hint: 'Hint',
      describedBy: 'policy',
      value: 'a@example.test',
    });
    expect(valid).toContain(
      'value="a@example.test" name="email" aria-describedby="policy email-hint">',
    );
    expect(valid).not.toContain('aria-invalid');
    expect(valid).not.toContain('role="alert"');
    expect(valid).not.toContain('data-invalid');
    const several = await render('textField', {
      ...email,
      error: ['Too short.', 'Must contain @.'],
    });
    expect(several).toContain(
      '<p class="nv-field__message">Too short.</p><p class="nv-field__message">Must contain @.</p>',
    );
  });
  it('renders the ids and messages of a @nestvexa/forms field view', async () => {
    const errors = { email: ['Enter a valid email address.'] };
    const view = fieldView(errors, 'email', { idPrefix: 'profile-' });
    const html = await render('textField', {
      name: 'email',
      label: 'Email',
      field: view,
    });
    expect(html).toContain('<input id="profile-email"');
    expect(html).toContain(
      'aria-invalid="true" aria-describedby="profile-email-error">',
    );
    expect(html).toContain(
      `<div class="nv-field__error" id="${view.errorId}" role="alert"><p class="nv-field__message">Enter a valid email address.</p></div>`,
    );
    // The forms error summary links to the control rendered here.
    const summary = errorSummary(errors, { idPrefix: 'profile-' });
    expect(summary.items[0]?.href).toBe('#profile-email');
    // JSON round trips (Live state) keep the same shape.
    const json: unknown = JSON.parse(JSON.stringify(view));
    expect(
      await render('textField', { name: 'email', label: 'Email', field: json }),
    ).toBe(html);
    const clean = await render('textField', {
      name: 'email',
      label: 'Email',
      field: fieldView({}, 'email', { idPrefix: 'profile-' }),
    });
    expect(clean).not.toContain('aria-invalid');
    for (const model of [
      { name: 'email', label: 'Email', field: view, error: 'x' },
      { id: 'other', name: 'email', label: 'Email', field: view },
      { name: 'email', label: 'Email', field: { ...view, extra: 1 } },
      { name: 'email', label: 'Email', field: { ...view, errorId: 'a b' } },
    ])
      expect(await failure('textField', model)).toBeInstanceOf(UiError);
  });
  it('passes Live nv:model attributes through with closed modifiers', async () => {
    const html = await render('textField', {
      id: 'city',
      label: 'City',
      model: 'address.city',
      modifiers: 'live.debounce.300ms',
    });
    expect(html).toContain('nv:model.live.debounce.300ms="address.city"');
    expect(html).not.toContain('name=');
    expect(
      await render('textField', {
        ...email,
        model: 'email',
        modifiers: 'blur',
      }),
    ).toContain('name="email" nv:model.blur="email"');
    expect(await render('textField', { ...email, model: 'email' })).toContain(
      ' nv:model="email"',
    );
    for (const model of [
      { id: 'x', label: 'X' },
      { ...email, model: 'a..b' },
      { ...email, model: '__proto__' },
      { ...email, model: 'a.constructor' },
      { ...email, model: 'a b' },
      { ...email, model: 'x', modifiers: 'blur onfocus' },
      { ...email, model: 'x', modifiers: 'x" onfocus="alert(1)' },
      { ...email, model: 'x', modifiers: 'click' },
    ])
      expect(await failure('textField', model)).toBeInstanceOf(UiError);
  });
  it('escapes labels, hints, errors and values (no markup or attribute injection)', async () => {
    const html = await render('textField', {
      ...email,
      label: '<script>alert(1)</script>',
      hint: '" onmouseover="alert(1)',
      error: '<img src=x onerror=alert(1)>',
      value: '"><script>alert(2)</script>',
      placeholder: "' autofocus onfocus='alert(3)",
    });
    expect(html).not.toMatch(/<script|<img|\son[a-z]+=/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot; onmouseover&#61;&quot;alert(1)');
    expect(html).toContain('&lt;img src&#61;x onerror&#61;alert(1)&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(2)');
    for (const model of [
      { ...email, id: 'x" onfocus="a' },
      { ...email, id: '1email' },
      { ...email, name: 'a b' },
      { ...email, name: 'a[__proto__]' },
      { ...email, name: 'constructor.x' },
      { ...email, type: 'text" onfocus="a' },
      { ...email, type: 'hidden' },
      { ...email, klass: 'a"b' },
      { ...email, autocomplete: 'email" onfocus="a' },
      { ...email, describedBy: 'a b' },
      { ...email, error: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...email, error: { message: 'x' } },
      { ...email, error: [{ text: 'x' }] },
      { ...email, minLength: 5, maxLength: 2 },
      { ...email, maxLength: -1 },
      { ...email, required: 'yes' },
    ])
      expect(await failure('textField', model)).toBeInstanceOf(UiError);
    expect(
      await render('textField', { ...email, name: 'items[0][email]' }),
    ).toContain('name="items[0][email]"');
  });
  it('renders textareas with escaped initial text and bounded rows', async () => {
    expect(
      await render('textareaField', {
        rows: 4,
        value: '</textarea><script>x</script>',
      }),
    ).toBe(
      '<div class="nv-field nv-field--textarea"><label class="nv-field__label" for="bio">Biography</label><textarea id="bio" class="nv-field__control" rows="4" maxlength="500" name="bio">&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;</textarea></div>',
    );
    for (const rows of [0, 51, 2.5, '4'])
      expect(await failure('textareaField', { rows })).toBeInstanceOf(UiError);
  });
  it('renders native selects with a placeholder, selection and validated options', async () => {
    const options = [
      { value: 'eg', label: 'Egypt' },
      { value: 'fr', label: 'France <FR>' },
    ];
    const html = await render('selectField', {
      options,
      value: 'fr',
      placeholder: 'Choose a country',
      model: 'country',
    });
    expect(html).toContain(
      '<select id="country" class="nv-field__control" name="country" required aria-required="true" nv:model.change="country"><option value="">Choose a country</option><option value="eg">Egypt</option><option value="fr" selected>France &lt;FR&gt;</option></select>',
    );
    expect(
      await render('selectField', { options, placeholder: 'Choose' }),
    ).toContain('<option value="" selected>Choose</option>');
    for (const model of [
      { options, value: 'de' },
      { options: [...options, options[0]] },
      { options: [{ value: 'x', label: 'X', onclick: 'y' }] },
      { options: [] },
      { options: 'eg' },
    ])
      expect(await failure('selectField', model)).toBeInstanceOf(UiError);
  });
  it('renders a checkbox followed by its label with hint and error', async () => {
    expect(
      await render('checkboxField', {
        label: 'I accept the terms',
        checked: true,
        error: 'You must accept the terms.',
      }),
    ).toBe(
      '<div class="nv-field nv-field--checkbox" data-invalid><input id="terms" class="nv-field__checkbox" type="checkbox" value="yes" checked name="terms" required aria-required="true" aria-invalid="true" aria-describedby="terms-hint terms-error"><label class="nv-field__label" for="terms">I accept the terms<span class="nv-field__required" aria-hidden="true">*</span></label><p class="nv-field__hint" id="terms-hint">Required to continue</p><div class="nv-field__error" id="terms-error" role="alert"><p class="nv-field__message">You must accept the terms.</p></div></div>',
    );
  });
  it('renders radio groups as a radiogroup fieldset whose first radio carries the field id', async () => {
    const html = await render('radioField', {
      name: 'plan',
      options: plans,
      value: 'pro',
      required: true,
      hint: 'Change it later.',
      error: 'Choose a plan.',
    });
    expect(html).toBe(
      '<fieldset class="nv-field nv-field--radio" role="radiogroup" aria-required="true" aria-describedby="plan-hint plan-error" data-invalid><legend class="nv-field__legend">Plan<span class="nv-field__required" aria-hidden="true">*</span></legend><p class="nv-field__hint" id="plan-hint">Change it later.</p><div class="nv-field__options"><div class="nv-field__option"><input id="plan" class="nv-field__radio" type="radio" name="plan" value="basic" required aria-invalid="true"><label class="nv-field__option-label" for="plan">Basic</label></div><div class="nv-field__option"><input id="plan-2" class="nv-field__radio" type="radio" name="plan" value="pro" checked required aria-invalid="true"><label class="nv-field__option-label" for="plan-2">Pro</label></div><div class="nv-field__option"><input id="plan-3" class="nv-field__radio" type="radio" name="plan" value="team" required disabled aria-invalid="true"><label class="nv-field__option-label" for="plan-3">Team</label></div></div><div class="nv-field__error" id="plan-error" role="alert"><p class="nv-field__message">Choose a plan.</p></div></fieldset>',
    );
    const live = await render('radioField', {
      options: plans,
      model: 'plan',
    });
    expect(live.match(/ nv:model="plan"/g)).toHaveLength(3);
    expect(live).not.toContain('name=');
    expect(
      await render('radioField', {
        name: 'plan',
        options: plans,
        field: fieldView({ plan: ['Choose a plan.'] }, 'plan'),
      }),
    ).toContain('aria-describedby="plan-error"');
    for (const model of [
      { name: 'plan', options: plans, value: 'free' },
      { name: 'plan', options: [] },
      {
        name: 'plan',
        options: Array.from({ length: 101 }, (_, index) => ({
          value: `v${index}`,
          label: 'x',
        })),
      },
    ])
      expect(await failure('radioField', model)).toBeInstanceOf(UiError);
  });
});
