import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
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
