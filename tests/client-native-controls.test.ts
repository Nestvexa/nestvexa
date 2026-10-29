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

declare global {
  interface Window {
    nvNativeFixture: typeof import('../packages/client/dist/morph.js') &
      Pick<
        typeof import('../packages/client/dist/index.js'),
        'createLiveClient'
      >;
  }
}

let browser: Browser;
let server: Server;
let page: Page;
let base: string;
let errors: string[];

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html lang="en"><head><title>Native form morph fixture</title><script type="module" src="/fixture.js"></script></head><body><main id="fixture"></main></body></html>',
        );
      return;
    }
    if (pathname === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as morph from '/morph.js'; import {createLiveClient} from '/index.js'; window.nvNativeFixture = {...morph, createLiveClient};",
        );
      return;
    }
    const name = /^\/([a-z][a-z0-9-]*)\.js$/.exec(pathname)?.[1];
    if (!name) {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL(`../packages/client/dist/${name}.js`, import.meta.url),
      'utf8',
    ).then(
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
    throw new Error('Missing native-control fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  errors = [];
  page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Reflect.has(window, 'nvNativeFixture'));
});
afterEach(async () => {
  if (page) await page.close();
  expect(errors).toEqual([]);
});
afterAll(async () => {
  if (browser) await browser.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

async function mount(markup: string): Promise<void> {
  await page.locator('#fixture').evaluate((root, markup) => {
    root.innerHTML = markup;
  }, markup);
}
async function morph(
  markup: string,
  dirty: readonly (readonly [string, unknown])[] = [],
): Promise<void> {
  await page.locator('#fixture').evaluate(
    (root, { markup, dirty }) => {
      const template = document.createElement('template');
      template.innerHTML = markup;
      window.nvNativeFixture.validateFragment(template.content);
      window.nvNativeFixture.morphChildren(
        root,
        template.content,
        new Map(dirty),
      );
    },
    { markup, dirty },
  );
}

/** Real Chromium form semantics against built morph code; no Nest/server conformance is claimed here. */
describe('native form values during ordinary DOM morphing', () => {
  it.each(['text', 'email', 'number'])(
    'preserves an unbound %s edit when its server default stays the same',
    async (type) => {
      const initial = type === 'number' ? '12' : 'initial';
      const edit = type === 'number' ? '34' : 'local edit';
      const markup = `<input id="edit" type="${type}" value="${initial}">`;
      await mount(markup);
      await page.locator('#edit').fill(edit);
      await morph(markup);
      expect(await page.locator('#edit').inputValue()).toBe(edit);
      expect(
        await page
          .locator('#edit')
          .evaluate((element) => (element as HTMLInputElement).defaultValue),
      ).toBe(initial);
    },
  );

  it.each(['text', 'number'])(
    'applies a changed server default to an unbound %s control',
    async (type) => {
      await mount(`<input id="edit" type="${type}" value="12">`);
      await page.locator('#edit').fill('34');
      await morph(`<input id="edit" type="${type}" value="56">`);
      expect(await page.locator('#edit').inputValue()).toBe('56');
    },
  );

  it('retains textarea drafts on stable defaults and updates reset semantics after a new default', async () => {
    await mount(
      '<form id="form"><textarea id="edit">initial</textarea></form>',
    );
    await page.locator('#edit').fill('local draft');
    await morph(
      '<form id="form"><textarea id="edit">initial</textarea></form>',
    );
    expect(await page.locator('#edit').inputValue()).toBe('local draft');
    await morph(
      '<form id="form"><textarea id="edit">new server default</textarea></form>',
    );
    expect(await page.locator('#edit').inputValue()).toBe('new server default');
    expect(
      await page
        .locator('#edit')
        .evaluate((element) => (element as HTMLTextAreaElement).defaultValue),
    ).toBe('new server default');
    await page.locator('#edit').fill('another draft');
    await page
      .locator('#form')
      .evaluate((element) => (element as HTMLFormElement).reset());
    expect(await page.locator('#edit').inputValue()).toBe('new server default');
  });

  it.each(['input', 'textarea'])(
    'keeps a newer model-bound %s value while updating its server reset default',
    async (tag) => {
      const html = (value: string) =>
        tag === 'input'
          ? `<form id="form"><input id="edit" nv:model="query" value="${value}"></form>`
          : `<form id="form"><textarea id="edit" nv:model="query">${value}</textarea></form>`;
      await mount(html('initial'));
      await page.locator('#edit').fill('newer local value');
      await morph(html('server'), [['query', 'newer local value']]);
      expect(await page.locator('#edit').inputValue()).toBe(
        'newer local value',
      );
      await page
        .locator('#form')
        .evaluate((element) => (element as HTMLFormElement).reset());
      expect(await page.locator('#edit').inputValue()).toBe('server');
    },
  );

  it('lets the server update a model-bound control with no newer dirty edit', async () => {
    await mount('<textarea id="edit" nv:model="query">initial</textarea>');
    await page.locator('#edit').fill('old client value');
    await morph('<textarea id="edit" nv:model="query">server</textarea>');
    expect(await page.locator('#edit').inputValue()).toBe('server');
    expect(
      await page
        .locator('#edit')
        .evaluate((element) => (element as HTMLTextAreaElement).defaultValue),
    ).toBe('server');
  });

  it('does not carry a dirty value across a model binding rename', async () => {
    await mount('<input id="edit" nv:model="oldField" value="initial">');
    await page.locator('#edit').fill('old field draft');
    await morph(
      '<input id="edit" nv:model="newField" value="new field server">',
      [['oldField', 'old field draft']],
    );
    expect(await page.locator('#edit').inputValue()).toBe('new field server');
  });

  it('does not retain a text draft across an input type change', async () => {
    await mount('<input id="edit" nv:model="query" type="text" value="12">');
    await page.locator('#edit').fill('99');
    await morph('<input id="edit" nv:model="query" type="number" value="7">', [
      ['query', '99'],
    ]);
    expect(await page.locator('#edit').inputValue()).toBe('7');
  });

  it('does not retain a raw draft after the model conversion changes', async () => {
    await mount('<input id="edit" nv:model="query" value="12">');
    await page.locator('#edit').fill('99');
    await morph('<input id="edit" nv:model.number="query" value="7">', [
      ['query', '99'],
    ]);
    expect(await page.locator('#edit').inputValue()).toBe('7');
  });

  it('retains an unbound single selection through keyed option reorder with unchanged defaults', async () => {
    await mount(
      '<select id="edit"><option id="a" value="a" selected>A</option><option id="b" value="b">B</option></select>',
    );
    await page.locator('#edit').selectOption('b');
    await morph(
      '<select id="edit"><option id="b" value="b">New B</option><option id="a" value="a" selected>New A</option></select>',
    );
    expect(await page.locator('#edit').inputValue()).toBe('b');
  });

  it('applies changed server selected defaults across the full single-select control', async () => {
    await mount(
      '<select id="edit"><option value="a" selected>A</option><option value="b">B</option><option value="c">C</option></select>',
    );
    await page.locator('#edit').selectOption('b');
    await morph(
      '<select id="edit"><option value="a">A</option><option value="b">B</option><option value="c" selected>C</option></select>',
    );
    expect(await page.locator('#edit').inputValue()).toBe('c');
  });

  it('falls back to the new server choice when an unbound selected option is removed', async () => {
    await mount(
      '<select id="edit"><option value="a">A</option><option value="b">B</option></select>',
    );
    await page.locator('#edit').selectOption('b');
    await morph(
      '<select id="edit"><option value="c">C</option><option value="a">A</option></select>',
    );
    expect(await page.locator('#edit').inputValue()).toBe('c');
  });

  it('preserves every local multiple selection, then accepts a changed explicit default and reset', async () => {
    const original =
      '<form id="form"><select id="edit" multiple><option id="a" value="a" selected>A</option><option id="b" value="b">B</option><option id="c" value="c">C</option></select></form>';
    await mount(original);
    await page.locator('#edit').selectOption(['b', 'c']);
    await morph(
      '<form id="form"><select id="edit" multiple><option id="c" value="c">C</option><option id="a" value="a" selected>A</option><option id="b" value="b">B</option></select></form>',
    );
    const selected = () =>
      page
        .locator('#edit')
        .evaluate((element) =>
          [...(element as HTMLSelectElement).selectedOptions].map(
            (option) => option.value,
          ),
        );
    expect(await selected()).toEqual(['c', 'b']);
    await morph(
      '<form id="form"><select id="edit" multiple><option id="a" value="a">A</option><option id="b" value="b">B</option><option id="c" value="c" selected>C</option></select></form>',
    );
    expect(await selected()).toEqual(['c']);
    await page.locator('#edit').selectOption('a');
    await page
      .locator('#form')
      .evaluate((element) => (element as HTMLFormElement).reset());
    expect(await selected()).toEqual(['c']);
  });

  it('preserves keyed selected-option identity even when values are duplicated', async () => {
    await mount(
      '<select id="edit"><option id="first" value="same" selected>First</option><option id="second" value="same">Second</option><option id="other" value="other">Other</option></select>',
    );
    await page.locator('#edit').evaluate((element) => {
      (element as HTMLSelectElement).selectedIndex = 1;
    });
    await morph(
      '<select id="edit"><option id="other" value="other">Other moved</option><option id="first" value="same" selected>First</option><option id="second" value="same">Second</option></select>',
    );
    expect(
      await page
        .locator('#edit')
        .evaluate(
          (element) => (element as HTMLSelectElement).selectedOptions[0]?.id,
        ),
    ).toBe('second');
  });

  it('preserves a newer model selection after keyed option reorder', async () => {
    await mount(
      '<select id="edit" nv:model="choice"><option id="a" value="a" selected>A</option><option id="b" value="b">B</option></select>',
    );
    await page.locator('#edit').selectOption('b');
    await morph(
      '<select id="edit" nv:model="choice"><option id="b" value="b">B</option><option id="a" value="a" selected>A</option></select>',
      [['choice', 'b']],
    );
    expect(await page.locator('#edit').inputValue()).toBe('b');
  });

  it('uses incoming selection for a model-bound select without a newer dirty edit', async () => {
    await mount(
      '<select id="edit" nv:model="choice"><option value="a" selected>A</option><option value="b">B</option></select>',
    );
    await page.locator('#edit').selectOption('b');
    await morph(
      '<select id="edit" nv:model="choice"><option value="a" selected>A</option><option value="b">B</option></select>',
    );
    expect(await page.locator('#edit').inputValue()).toBe('a');
  });

  it('preserves a dirty radio choice when incoming markup inserts a newly checked sibling', async () => {
    await mount(
      '<input id="a" type="radio" name="choice" nv:model="choice" value="a" checked><input id="b" type="radio" name="choice" nv:model="choice" value="b">',
    );
    await page.locator('#b').check();
    await morph(
      '<input id="a" type="radio" name="choice" nv:model="choice" value="a"><input id="b" type="radio" name="choice" nv:model="choice" value="b"><input id="c" type="radio" name="choice" nv:model="choice" value="c" checked>',
      [['choice', 'b']],
    );
    expect(await page.locator('#a').isChecked()).toBe(false);
    expect(await page.locator('#b').isChecked()).toBe(true);
    expect(await page.locator('#c').isChecked()).toBe(false);
  });

  it('retains dirty checkbox checkedness even when server defaults change', async () => {
    await mount('<input id="edit" type="checkbox" nv:model="enabled" checked>');
    await page.locator('#edit').uncheck();
    await morph(
      '<input id="edit" type="checkbox" nv:model="enabled" checked>',
      [['enabled', false]],
    );
    expect(await page.locator('#edit').isChecked()).toBe(false);
  });

  it('leaves a dirty radio group unselected when the draft choice disappears', async () => {
    await mount(
      '<input id="a" type="radio" name="choice" nv:model="choice" value="a" checked><input id="b" type="radio" name="choice" nv:model="choice" value="b">',
    );
    await page.locator('#b').check();
    await morph(
      '<input id="a" type="radio" name="choice" nv:model="choice" value="a"><input id="c" type="radio" name="choice" nv:model="choice" value="c" checked>',
      [['choice', 'b']],
    );
    expect(await page.locator('#a').isChecked()).toBe(false);
    expect(await page.locator('#c').isChecked()).toBe(false);
  });

  it('preserves unbound checkbox choice while its default is stable and accepts a changed default', async () => {
    await mount('<input id="edit" type="checkbox" checked>');
    await page.locator('#edit').uncheck();
    await morph('<input id="edit" type="checkbox" checked>');
    expect(await page.locator('#edit').isChecked()).toBe(false);
    await morph('<input id="edit" type="checkbox">');
    expect(await page.locator('#edit').isChecked()).toBe(false);
    await morph('<input id="edit" type="checkbox" checked>');
    expect(await page.locator('#edit').isChecked()).toBe(true);
  });

  it('retains an unbound radio choice when its group default is stable', async () => {
    await mount(
      '<input id="a" type="radio" name="choice" value="a" checked><input id="b" type="radio" name="choice" value="b">',
    );
    await page.locator('#b').check();
    await morph(
      '<input id="a" type="radio" name="choice" value="a" checked><input id="b" type="radio" name="choice" value="b"><input id="c" type="radio" name="choice" value="c">',
    );
    expect(await page.locator('#a').isChecked()).toBe(false);
    expect(await page.locator('#b').isChecked()).toBe(true);
    expect(await page.locator('#c').isChecked()).toBe(false);
  });

  it.each([
    { label: 'different missing IDs', first: 'missing-a', second: 'missing-b' },
    { label: 'empty and missing IDs', first: '', second: 'missing-b' },
    {
      label: 'non-form and missing IDs',
      first: 'not-form',
      second: 'missing-b',
    },
    { label: 'missing and absent IDs', first: 'missing-a', second: null },
  ])(
    'uses actual ownerless radio grouping for $label',
    async ({ first, second }) => {
      const markup = (checked: boolean) =>
        `<div id="not-form"></div><input id="a" type="radio" name="choice" form="${first}" value="a"${checked ? ' checked' : ''}><input id="b" type="radio" name="choice"${second === null ? '' : ` form="${second}"`} value="b">`;
      await mount(markup(false));
      expect(
        await page
          .locator('input')
          .evaluateAll((elements) =>
            elements.map(
              (element) => (element as HTMLInputElement).form === null,
            ),
          ),
      ).toEqual([true, true]);
      await page.locator('#b').check();
      await morph(markup(true));
      expect(await page.locator('#a').isChecked()).toBe(true);
      expect(await page.locator('#b').isChecked()).toBe(false);
    },
  );

  it.each(['internal', 'external'])(
    'keeps valid %s form references separate from ownerless radio groups',
    async (location) => {
      if (location === 'external')
        await page.evaluate(() => {
          const form = document.createElement('form');
          form.id = 'associated';
          document.body.prepend(form);
        });
      const markup = (checked: boolean) =>
        `${location === 'internal' ? '<form id="associated"></form>' : ''}<input id="a" type="radio" name="choice" form="associated" value="a"${checked ? ' checked' : ''}><input id="b" type="radio" name="choice" form="associated" value="b"><input id="c" type="radio" name="choice" value="c"><input id="d" type="radio" name="choice" value="d">`;
      await mount(markup(false));
      expect(
        await page
          .locator('#a')
          .evaluate((element) => (element as HTMLInputElement).form?.id),
      ).toBe('associated');
      await page.locator('#b').check();
      await page.locator('#d').check();
      await morph(markup(false));
      expect(await page.locator('#a').isChecked()).toBe(false);
      expect(await page.locator('#b').isChecked()).toBe(true);
      expect(await page.locator('#d').isChecked()).toBe(true);
      await morph(markup(true));
      expect(await page.locator('#a').isChecked()).toBe(true);
      expect(await page.locator('#b').isChecked()).toBe(false);
      expect(await page.locator('#c').isChecked()).toBe(false);
      expect(await page.locator('#d').isChecked()).toBe(true);
    },
  );

  it.each(['identified', 'anonymous'])(
    'inherits the retained %s outer form only for controls without a form attribute',
    async (identity) => {
      await page.locator('#fixture').evaluate((root, identity) => {
        const form = document.createElement('form');
        if (identity === 'identified') form.id = 'outer';
        root.replaceWith(form);
        form.append(root);
      }, identity);
      const markup = (checked: boolean) =>
        `<input id="a" type="radio" name="choice" value="a"${checked ? ' checked' : ''}><input id="b" type="radio" name="choice" value="b"><input id="c" type="radio" name="choice" form="missing" value="c"><input id="d" type="radio" name="choice" form="missing" value="d">`;
      await mount(markup(false));
      await page.locator('#b').check();
      await page.locator('#d').check();
      await morph(markup(false));
      expect(await page.locator('#b').isChecked()).toBe(true);
      expect(await page.locator('#d').isChecked()).toBe(true);
      await morph(markup(true));
      expect(await page.locator('#a').isChecked()).toBe(true);
      expect(await page.locator('#b').isChecked()).toBe(false);
      expect(await page.locator('#d').isChecked()).toBe(true);
    },
  );

  it('uses the new server radio-group default when a newly inserted sibling becomes the default', async () => {
    await mount(
      '<input id="a" type="radio" name="choice" value="a" checked><input id="b" type="radio" name="choice" value="b">',
    );
    await page.locator('#b').check();
    await morph(
      '<input id="a" type="radio" name="choice" value="a"><input id="b" type="radio" name="choice" value="b"><input id="c" type="radio" name="choice" value="c" checked>',
    );
    expect(await page.locator('#a').isChecked()).toBe(false);
    expect(await page.locator('#b').isChecked()).toBe(false);
    expect(await page.locator('#c').isChecked()).toBe(true);
  });

  it('preserves file selection during ordinary morphing but resets it during explicit replacement', async () => {
    await mount('<section id="slot"><input id="file" type="file"></section>');
    await page.locator('#file').setInputFiles({
      name: 'example.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('fixture-only local file'),
    });
    await morph(
      '<section id="slot"><input id="file" type="file" aria-label="Updated attachment"></section>',
    );
    expect(
      await page
        .locator('#file')
        .evaluate((element) => (element as HTMLInputElement).files?.[0]?.name),
    ).toBe('example.txt');
    await morph(
      '<section id="slot" nv:replace=""><input id="file" type="file"></section>',
    );
    expect(
      await page
        .locator('#file')
        .evaluate((element) => (element as HTMLInputElement).files?.length),
    ).toBe(0);
  });

  it('preserves editable content while allowing contenteditable=false server updates', async () => {
    await mount(
      '<div id="editable" contenteditable="true">initial</div><div id="plain" contenteditable="false">initial</div>',
    );
    await page.locator('#editable').fill('local editor text');
    await morph(
      '<div id="editable" contenteditable="true">server editor text</div><div id="plain" contenteditable="false">server plain text</div>',
    );
    expect(await page.locator('#editable').textContent()).toBe(
      'local editor text',
    );
    expect(await page.locator('#plain').textContent()).toBe(
      'server plain text',
    );
    await morph(
      '<div id="editable" contenteditable="false">server takes ownership</div><div id="plain" contenteditable="false">server plain text</div>',
    );
    expect(await page.locator('#editable').textContent()).toBe(
      'server takes ownership',
    );
  });

  it('accepts a multiple-select model catalog and rejects ambiguous incoming values before patching', async () => {
    await mount(
      '<select id="edit" nv:model="choice" multiple><option value="a">A</option></select>',
    );
    await morph(
      '<select id="edit" nv:model="choice" multiple><option value="a">A</option></select>',
    );
    await expect(
      morph(
        '<select id="edit" nv:model="choice" multiple><option value="a">A</option><option value="a">Duplicate</option></select>',
      ),
    ).rejects.toThrow('Multiple-select');
    expect(await page.locator('#edit option').count()).toBe(1);
  });

  it('keeps unbound local values out of Live public state and request updates', async () => {
    const result = await page.evaluate(async () => {
      const main = document.getElementById('fixture');
      if (!main) throw new Error('Missing fixture');
      const root = document.createElement('section');
      for (const [name, value] of Object.entries({
        'data-nv-component': '11111111-1111-4111-8111-111111111111',
        'data-nv-name': 'editor',
        'data-nv-snapshot': 'opaque',
        'data-nv-revision': '0',
        'data-nv-endpoint': '/live/editor',
        'data-nv-csrf': 'fixture-csrf',
        'data-nv-state': '{"count":0}',
      }))
        root.setAttribute(name, value);
      root.innerHTML = '<input id="local" name="privateDraft" value="initial">';
      main.append(root);
      const input = root.querySelector<HTMLInputElement>('input');
      if (!input) throw new Error('Missing input');
      let updates: unknown;
      const clientErrors: string[] = [];
      const client = window.nvNativeFixture.createLiveClient({
        root,
        onError: (error) => clientErrors.push(error.message),
        fetch: async (_url, options) => {
          const body = JSON.parse(String(options?.body)) as {
            requestId: string;
            revision: number;
            updates: unknown;
          };
          updates = body.updates;
          return new Response(
            JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: body.requestId,
              component: {
                id: root.getAttribute('data-nv-component'),
                name: 'editor',
                revision: body.revision + 1,
              },
              snapshot: 'opaque',
              state: { count: 1 },
              html: '<input id="local" name="privateDraft" value="initial">',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      });
      try {
        client.mount();
        input.value = 'local unsent draft';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        let unknownField = '';
        try {
          client.get(root, 'privateDraft');
        } catch (error) {
          unknownField = error instanceof Error ? error.message : 'unknown';
        }
        await client.call(root, 'refresh');
        return {
          updates,
          value: root.querySelector<HTMLInputElement>('input')?.value,
          unknownField,
          errors: clientErrors,
        };
      } finally {
        client.dispose();
      }
    });
    expect(result.updates).toEqual({});
    expect(result.value).toBe('local unsent draft');
    expect(result.unknownField).toBe('Unknown public state field');
    expect(result.errors).toEqual([]);
  });

  it.each(['type', 'cast'])(
    'discards a newer hidden model draft when the retained input changes %s',
    async (boundary) => {
      const result = await page.evaluate(async (boundary) => {
        const main = document.getElementById('fixture');
        if (!main) throw new Error('Missing fixture');
        const root = document.createElement('section');
        for (const [name, value] of Object.entries({
          'data-nv-component': '11111111-1111-4111-8111-111111111111',
          'data-nv-name': 'editor',
          'data-nv-snapshot': 'opaque',
          'data-nv-revision': '0',
          'data-nv-endpoint': '/live/editor',
          'data-nv-csrf': 'fixture-csrf',
          'data-nv-state': '{"amount":"12"}',
        }))
          root.setAttribute(name, value);
        root.innerHTML =
          '<input id="edit" nv:model="amount" type="text" value="12">';
        main.append(root);
        const input = root.querySelector<HTMLInputElement>('input');
        if (!input) throw new Error('Missing input');
        const updates: Record<string, unknown>[] = [];
        const replies: (() => void)[] = [];
        const errors: string[] = [];
        const html =
          boundary === 'type'
            ? '<input id="edit" nv:model="amount" type="number" value="7">'
            : '<input id="edit" nv:model.number="amount" type="text" value="7">';
        const client = window.nvNativeFixture.createLiveClient({
          root,
          onError: (error) => errors.push(error.message),
          fetch: (_url, options) => {
            const body = JSON.parse(String(options?.body)) as {
              requestId: string;
              revision: number;
              updates: Record<string, unknown>;
            };
            updates.push(body.updates);
            return new Promise<Response>((resolve) =>
              replies.push(() =>
                resolve(
                  new Response(
                    JSON.stringify({
                      protocol: 'nestvexa-live/1',
                      requestId: body.requestId,
                      component: {
                        id: root.getAttribute('data-nv-component'),
                        name: 'editor',
                        revision: body.revision + 1,
                      },
                      snapshot: 'opaque',
                      state: { amount: 7 },
                      html,
                    }),
                    { headers: { 'content-type': 'application/json' } },
                  ),
                ),
              ),
            );
          },
        });
        try {
          client.mount();
          input.value = '99';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const first = client.call(root, 'refresh');
          await Promise.resolve();
          input.value = '101';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const initialReply = replies[0];
          if (!initialReply) throw new Error('Missing first response');
          initialReply();
          await first;
          const valueAfterTypeChange = client.get(root, 'amount');
          const next = client.call(root, 'save');
          await Promise.resolve();
          const nextReply = replies[1];
          if (!nextReply) throw new Error('Missing next response');
          nextReply();
          await next;
          return {
            updates,
            valueAfterTypeChange,
            value: root.querySelector<HTMLInputElement>('input')?.value,
            errors,
          };
        } finally {
          client.dispose();
        }
      }, boundary);
      expect(result.updates).toEqual([{ amount: '99' }, {}]);
      expect(result.valueAfterTypeChange).toBe(7);
      expect(result.value).toBe('7');
      expect(result.errors).toEqual([]);
    },
  );
});
