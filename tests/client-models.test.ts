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
import {
  coerceModelValue,
  copyModelArray,
  MODEL_ARRAY_LIMITS,
  parseModelDirective,
  sameModelValue,
} from '../packages/client/dist/models.js';

declare global {
  interface Window {
    nvModelFixture: typeof import('../packages/client/dist/models.js');
  }
}

describe('closed model directive grammar', () => {
  it('defaults to deferred automatic primitive conversion', () => {
    expect(parseModelDirective('nv:model', 'name')).toEqual({
      field: 'name',
      mode: 'defer',
      cast: 'auto',
    });
    expect(Object.isFrozen(parseModelDirective('nv:model', 'name'))).toBe(true);
  });
  it('supports live, explicit timing and boundary modes without ambiguity', () => {
    expect(parseModelDirective('nv:model.live.number', 'amount')).toEqual({
      field: 'amount',
      mode: 'live',
      cast: 'number',
      debounceMs: 150,
    });
    expect(parseModelDirective('nv:model.debounce', 'name')).toMatchObject({
      mode: 'live',
      debounceMs: 250,
    });
    expect(
      parseModelDirective('nv:model.live.debounce.1ms', 'name').debounceMs,
    ).toBe(1);
    expect(
      parseModelDirective('nv:model.throttle.60000ms.boolean', 'enabled'),
    ).toMatchObject({ mode: 'live', throttleMs: 60000, cast: 'boolean' });
    expect(parseModelDirective('nv:model.blur', 'name').mode).toBe('blur');
    expect(parseModelDirective('nv:model.change', 'name').mode).toBe('change');
    expect(parseModelDirective('nv:model.lazy', 'name').mode).toBe('change');
    expect(parseModelDirective('nv:model.defer', 'name').mode).toBe('defer');
  });
  it.each([
    'nv:model.live.blur',
    'nv:model.change.lazy',
    'nv:model.defer.live',
    'nv:model.number.boolean',
    'nv:model.number.number',
    'nv:model.live.live',
    'nv:model.blur.debounce.100ms',
    'nv:model.change.throttle.100ms',
    'nv:model.defer.debounce',
    'nv:model.debounce.throttle',
    'nv:model.debounce.0ms',
    'nv:model.throttle.60001ms',
    'nv:model.debounce.1.5ms',
    'nv:model.300ms',
    'nv:model.debounce.2ms.3ms',
    'nv:model.',
    'nv:model.window',
    'nv:model.document',
    'nv:model.prevent',
    'nv:modelx',
    'model',
    'nv:model.constructor',
    'nv:model.__proto__',
    'nv:model.debounce.9007199254740993ms',
    'nv:model.live.debounce.300ms.debounce',
  ])('rejects unsupported or contradictory %s', (name) => {
    expect(() => parseModelDirective(name, 'field')).toThrow();
  });
  it.each([
    '',
    '__proto__',
    'constructor',
    'prototype',
    'form.name',
    'name()',
    'x y',
  ])('rejects unsafe state identifier %s', (field) => {
    expect(() => parseModelDirective('nv:model.live', field)).toThrow();
  });
});

describe('native browser model control readers', () => {
  let browser: Browser;
  let server: Server;
  let page: Page;
  let base: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          '<!doctype html><html lang="en"><head><title>Model fixture</title><script type="module">import * as models from "/models.js"; window.nvModelFixture=models;</script></head><body></body></html>',
        );
        return;
      }
      if (!['/models.js', '/grammar.js'].includes(path)) {
        response.writeHead(404).end();
        return;
      }
      void readFile(
        new URL(`../packages/client/dist${path}`, import.meta.url),
        'utf8',
      ).then(
        (source) => {
          response.writeHead(200, { 'Content-Type': 'text/javascript' });
          response.end(source);
        },
        () => response.writeHead(404).end(),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing model fixture port');
    base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(base);
    await page.waitForFunction(() => Reflect.has(window, 'nvModelFixture'));
  });
  afterEach(async () => {
    if (page) await page.close();
  });
  afterAll(async () => {
    if (browser) await browser.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });

  it('reads text, textarea, decimal, boolean select and checked radio without executing content', async () => {
    const values = await page.evaluate(() => {
      const markup = [
        '<input nv:model="name" value="&lt;script&gt;" />',
        '<textarea nv:model.blur="name">العربية</textarea>',
        '<input type="number" nv:model="amount" value="3.5" />',
        '<input type="checkbox" nv:model.boolean="enabled" checked />',
        '<select nv:model.change.boolean="enabled"><option value="0">No</option><option value="1" selected>Yes</option></select>',
        '<input type="radio" nv:model.lazy="kind" value="first" checked />',
        '<input type="radio" nv:model.lazy="kind" value="second" />',
      ];
      return markup.map((html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const control = template.content.firstElementChild;
        if (!control) throw new Error('Missing control');
        const directive = window.nvModelFixture.getModelDirective(control);
        if (!directive) throw new Error('Missing model');
        return {
          field: window.nvModelFixture.modelField(control),
          value:
            window.nvModelFixture.readModelValue(control, directive) ?? null,
        };
      });
    });
    expect(values).toEqual([
      { field: 'name', value: '<script>' },
      { field: 'name', value: 'العربية' },
      { field: 'amount', value: 3.5 },
      { field: 'enabled', value: true },
      { field: 'enabled', value: true },
      { field: 'kind', value: 'first' },
      { field: 'kind', value: null },
    ]);
  });
  it('rejects duplicate declarations, unsupported controls and foreign namespaces', async () => {
    const rejected = await page.evaluate(() => {
      const cases = [
        '<input nv:model="name" nv:model.live="name" />',
        '<input type="file" nv:model="file" />',
        '<button nv:model="name">Button</button>',
        '<input type="checkbox" nv:model.number="amount" />',
        '<svg><g nv:model="name"></g></svg>',
      ];
      return cases.map((html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const element = [...template.content.querySelectorAll('*')].find(
          (candidate) =>
            [...candidate.attributes].some(
              (attribute) =>
                attribute.name === 'nv:model' ||
                attribute.name.startsWith('nv:model.'),
            ),
        );
        if (!element) throw new Error('Missing control');
        try {
          window.nvModelFixture.getModelDirective(element);
          return false;
        } catch {
          return true;
        }
      });
    });
    expect(rejected).toEqual(Array.from({ length: 5 }, () => true));
  });
  it('reads multiple-select arrays in DOM order, including disabled selected options and empty selections', async () => {
    const values = await page.evaluate(() => {
      return [
        '<select multiple nv:model="items"><option value="" selected>Empty string</option><optgroup disabled><option value="العربية" selected>Arabic</option></optgroup><option value="other">Other</option></select>',
        '<select multiple nv:model.number="items"><option value="-0" selected>Zero</option><option value="2.5" selected>Decimal</option></select>',
        '<select multiple nv:model.boolean="items"><option value="0" selected>No</option><option value="1" selected>Yes</option></select>',
        '<select multiple nv:model="items"><option value="one">One</option></select>',
      ].map((html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const element = template.content.firstElementChild;
        if (!element) throw new Error('Missing select');
        const directive = window.nvModelFixture.getModelDirective(element);
        if (!directive) throw new Error('Missing model');
        const value = window.nvModelFixture.readModelValue(element, directive);
        return { value, frozen: Object.isFrozen(value) };
      });
    });
    expect(values).toEqual([
      { value: ['', 'العربية'], frozen: true },
      { value: [0, 2.5], frozen: true },
      { value: [false, true], frozen: true },
      { value: [], frozen: true },
    ]);
  });
  it.each([
    [
      'duplicate text',
      '<select multiple nv:model="items"><option value="a">First</option><option value="a">Second</option></select>',
    ],
    [
      'coerced numeric duplicate',
      '<select multiple nv:model.number="items"><option value="01">First</option><option value="1">Second</option></select>',
    ],
    [
      'zero duplicate',
      '<select multiple nv:model.number="items"><option value="-0">First</option><option value="0">Second</option></select>',
    ],
    [
      'coerced boolean duplicate',
      '<select multiple nv:model.boolean="items"><option value="true">First</option><option value="1">Second</option></select>',
    ],
    [
      'invalid unselected number',
      '<select multiple nv:model.number="items"><option value="1" selected>One</option><option value="">Empty</option></select>',
    ],
    [
      'invalid unselected boolean',
      '<select multiple nv:model.boolean="items"><option value="1" selected>Yes</option><option value="no">Invalid</option></select>',
    ],
    [
      'reactive label without value',
      '<select multiple nv:model="items"><option nv:text="label">Initial</option></select>',
    ],
  ])(
    'rejects an ambiguous multiple-select catalog before mutation: %s',
    async (_name, html) => {
      expect(
        await page.evaluate((html) => {
          const template = document.createElement('template');
          template.innerHTML = html;
          const element = template.content.firstElementChild;
          if (!element) throw new Error('Missing select');
          const before = element.outerHTML;
          try {
            window.nvModelFixture.getModelDirective(element);
            return false;
          } catch {
            return element.outerHTML === before;
          }
        }, html),
      ).toBe(true);
    },
  );
  it('permits a reactive option label when its value is explicit', async () => {
    expect(
      await page.evaluate(() => {
        const select = document.createElement('select');
        select.multiple = true;
        select.setAttribute('nv:model', 'items');
        select.innerHTML =
          '<option value="stable" nv:text="label" selected>Initial</option>';
        const directive = window.nvModelFixture.getModelDirective(select);
        if (!directive) throw new Error('Missing model');
        select.options[0]?.replaceChildren(
          document.createTextNode('New label'),
        );
        return window.nvModelFixture.readModelValue(select, directive);
      }),
    ).toEqual(['stable']);
  });
  it('enforces option-count, selection-count and UTF-8 array byte budgets', async () => {
    expect(
      await page.evaluate(() => {
        const results: boolean[] = [];
        for (const mode of ['options', 'items', 'bytes']) {
          const select = document.createElement('select');
          select.multiple = true;
          select.setAttribute('nv:model', 'items');
          const count = mode === 'options' ? 1025 : mode === 'items' ? 257 : 1;
          for (let index = 0; index < count; index++)
            select.add(
              new Option(
                mode,
                mode === 'bytes' ? '😀'.repeat(4096) : String(index),
                false,
                true,
              ),
            );
          try {
            const directive = window.nvModelFixture.getModelDirective(select);
            if (!directive) throw new Error('Missing directive');
            window.nvModelFixture.readModelValue(select, directive);
            results.push(false);
          } catch {
            results.push(true);
          }
        }
        return results;
      }),
    ).toEqual([true, true, true]);
  });
  it('accepts exact option and byte boundaries with bounded selected values', async () => {
    expect(
      await page.evaluate(() => {
        const select = document.createElement('select');
        select.multiple = true;
        select.setAttribute('nv:model', 'items');
        for (let index = 0; index < 1024; index++)
          select.add(
            new Option(String(index), String(index), false, index < 256),
          );
        const directive = window.nvModelFixture.getModelDirective(select);
        if (!directive) throw new Error('Missing directive');
        const values = window.nvModelFixture.readModelValue(select, directive);
        const large = document.createElement('select');
        large.multiple = true;
        large.setAttribute('nv:model', 'large');
        large.add(new Option('Long value', '😀'.repeat(4095), false, true));
        const largeDirective = window.nvModelFixture.getModelDirective(large);
        if (!largeDirective) throw new Error('Missing byte-limit directive');
        const largeValues = window.nvModelFixture.readModelValue(
          large,
          largeDirective,
        );
        return {
          count: Array.isArray(values) ? values.length : -1,
          bytes: new TextEncoder().encode(JSON.stringify(largeValues)).length,
        };
      }),
    ).toEqual({ count: 256, bytes: 16_384 });
  });
  it('plans membership projection without changing array order, native defaults or sending input events', async () => {
    expect(
      await page.evaluate(() => {
        const select = document.createElement('select');
        select.multiple = true;
        select.setAttribute('nv:model', 'items');
        select.innerHTML =
          '<option value="a" selected>A</option><option value="b">B</option><option value="c" disabled>C</option>';
        document.body.append(select);
        const directive = window.nvModelFixture.getModelDirective(select);
        if (!directive) throw new Error('Missing directive');
        let events = 0;
        select.addEventListener('input', () => events++);
        select.addEventListener('change', () => events++);
        const values = ['c', 'missing', 'b'];
        const plan = window.nvModelFixture.planModelSelection(
          select,
          directive,
          values,
        );
        if (!plan) throw new Error('Missing projection');
        const before = [...select.selectedOptions].map(
          (option) => option.value,
        );
        plan();
        return {
          before,
          selected: [...select.selectedOptions].map((option) => option.value),
          defaults: [...select.options].map((option) => option.defaultSelected),
          values,
          events,
        };
      }),
    ).toEqual({
      before: ['a'],
      selected: ['b', 'c'],
      defaults: [true, false, false],
      values: ['c', 'missing', 'b'],
      events: 0,
    });
  });
  it('projects numbers and booleans only from values matching the declared cast', async () => {
    expect(
      await page.evaluate(() => {
        return [
          {
            name: 'nv:model.number',
            options:
              '<option value="-0" selected>Zero</option><option value="2.5">Decimal</option>',
            value: [2.5],
            wrong: ['2.5'],
          },
          {
            name: 'nv:model.boolean',
            options:
              '<option value="0" selected>No</option><option value="1">Yes</option>',
            value: [true],
            wrong: ['true'],
          },
        ].map((item) => {
          const select = document.createElement('select');
          select.multiple = true;
          select.setAttribute(item.name, 'items');
          select.innerHTML = item.options;
          const directive = window.nvModelFixture.getModelDirective(select);
          if (!directive) throw new Error('Missing directive');
          let rejected = false;
          try {
            window.nvModelFixture.planModelSelection(
              select,
              directive,
              item.wrong,
            );
          } catch {
            rejected = true;
          }
          window.nvModelFixture.planModelSelection(
            select,
            directive,
            item.value,
          )?.();
          return {
            rejected,
            value: window.nvModelFixture.readModelValue(select, directive),
          };
        });
      }),
    ).toEqual([
      { rejected: true, value: [2.5] },
      { rejected: true, value: [true] },
    ]);
  });
  it('clears all selected options for an empty array and ignores non-multiple controls', async () => {
    expect(
      await page.evaluate(() => {
        const select = document.createElement('select');
        select.multiple = true;
        select.innerHTML = '<option value="a" selected>A</option>';
        const directive = window.nvModelFixture.parseModelDirective(
          'nv:model',
          'items',
        );
        window.nvModelFixture.planModelSelection(select, directive, [])?.();
        const input = document.createElement('input');
        const single = document.createElement('select');
        return {
          selected: select.selectedOptions.length,
          input:
            window.nvModelFixture.planModelSelection(input, directive, [
              'a',
            ]) === undefined,
          single:
            window.nvModelFixture.planModelSelection(single, directive, [
              'a',
            ]) === undefined,
        };
      }),
    ).toEqual({ selected: 0, input: true, single: true });
  });
  it('rejects empty native number inputs and ambiguous cast values without changing the control', async () => {
    const rejected = await page.evaluate(() => {
      return [
        '<input type="number" nv:model.live="amount" value="" />',
        '<input nv:model.number="amount" value="1x" />',
        '<select nv:model.boolean="enabled"><option value="yes">Yes</option></select>',
      ].map((html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const control = template.content.firstElementChild;
        if (!control) throw new Error('Missing control');
        const before = control.outerHTML;
        const directive = window.nvModelFixture.getModelDirective(control);
        if (!directive) throw new Error('Missing directive');
        try {
          window.nvModelFixture.readModelValue(control, directive);
          return false;
        } catch {
          return control.outerHTML === before;
        }
      });
    });
    expect(rejected).toEqual([true, true, true]);
  });
  it('does not infer a model for ordinary controls', async () => {
    expect(
      await page.evaluate(() => {
        const control = document.createElement('input');
        return (
          window.nvModelFixture.getModelDirective(control) === undefined &&
          window.nvModelFixture.modelField(control) === undefined
        );
      }),
    ).toBe(true);
  });
});

describe('primitive model coercion', () => {
  it.each([
    ['0', 0],
    ['-2.5', -2.5],
    ['.5', 0.5],
    ['+3', 3],
    ['2e3', 2000],
    [' 4.25 ', 4.25],
  ])('converts complete decimal %s', (raw, expected) => {
    expect(coerceModelValue(raw, 'number')).toBe(expected);
  });
  it.each([
    '',
    ' ',
    'Infinity',
    'NaN',
    '1e999',
    '0x10',
    '0b10',
    '1n',
    '1,5',
    '1x',
    '--1',
    '1.2.3',
  ])('rejects invalid number %s', (raw) => {
    expect(() => coerceModelValue(raw, 'number')).toThrow();
  });
  it('preserves finite numeric inputs and refuses to turn booleans into numbers', () => {
    expect(coerceModelValue(1.25, 'number')).toBe(1.25);
    expect(() => coerceModelValue(true, 'number')).toThrow();
    expect(() => coerceModelValue(Number.NaN, 'auto')).toThrow();
    expect(() => coerceModelValue(Infinity, 'number')).toThrow();
  });
  it.each([true, 'true', '1', 1, ' true '])(
    'accepts explicit true value %s',
    (raw) => {
      expect(coerceModelValue(raw, 'boolean')).toBe(true);
    },
  );
  it.each([false, 'false', '0', 0, ' false '])(
    'accepts explicit false value %s',
    (raw) => {
      expect(coerceModelValue(raw, 'boolean')).toBe(false);
    },
  );
  it.each(['yes', 'no', '', 'FALSE', 2, -1, 'undefined'])(
    'rejects ambiguous boolean %s',
    (raw) => {
      expect(() => coerceModelValue(raw, 'boolean')).toThrow();
    },
  );
  it('rejects objects without executing conversion hooks', () => {
    let invoked = false;
    const object = {
      toString() {
        invoked = true;
        return '1';
      },
      valueOf() {
        invoked = true;
        return 1;
      },
    };
    for (const raw of [object, [], null, undefined, Symbol('model'), 1n]) {
      expect(() => coerceModelValue(raw, 'number')).toThrow();
      expect(() => coerceModelValue(raw, 'boolean')).toThrow();
      expect(() => coerceModelValue(raw, 'auto')).toThrow();
    }
    expect(invoked).toBe(false);
  });
  it('keeps ordinary text and boolean values unchanged without an explicit cast', () => {
    expect(coerceModelValue('001', 'auto')).toBe('001');
    expect(coerceModelValue(false, 'auto')).toBe(false);
  });
});

describe('bounded flat model arrays', () => {
  it('copies and freezes values, normalizes wire zero, and compares ordered values', () => {
    const source = ['Arabic العربية', 2, false, -0];
    const copied = copyModelArray(source);
    source[0] = 'changed';
    expect(copied).toEqual(['Arabic العربية', 2, false, 0]);
    expect(Object.isFrozen(copied)).toBe(true);
    expect(sameModelValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameModelValue(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameModelValue([], [])).toBe(true);
    expect(sameModelValue([-0], [0])).toBe(true);
    expect(sameModelValue(['1'], [1])).toBe(false);
    expect(sameModelValue([], '')).toBe(false);
    expect(sameModelValue(1, 1)).toBe(true);
  });
  it.each(
    [
      null,
      {},
      [[1]],
      [NaN],
      [Infinity],
      [undefined],
      [1n],
      ['a', 'a'],
      [-0, 0],
      new Array(2),
      Array.from({ length: 257 }, (_, i) => i),
    ].map((raw) => ({ raw })),
  )('rejects unsupported or unbounded array $raw', ({ raw }) => {
    expect(() => copyModelArray(raw)).toThrow();
    expect(sameModelValue(raw, [])).toBe(false);
  });
  it('does not evaluate array getters, extra properties or conversion hooks', () => {
    let calls = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    const extra = [1];
    Object.defineProperty(extra, 'extra', {
      get() {
        calls++;
        return true;
      },
    });
    const symbolic = [1];
    Object.defineProperty(symbolic, Symbol('extra'), { value: 1 });
    const exotic = [1];
    Object.setPrototypeOf(exotic, null);
    for (const value of [
      accessor,
      extra,
      symbolic,
      exotic,
      [
        {
          toJSON() {
            calls++;
            return 1;
          },
        },
      ],
    ])
      expect(() => copyModelArray(value)).toThrow();
    expect(calls).toBe(0);
  });
  it('counts UTF-8 JSON punctuation and enforces exact byte and item bounds', () => {
    expect(copyModelArray(['😀'.repeat(4095)])).toHaveLength(1);
    expect(() => copyModelArray(['😀'.repeat(4096)])).toThrow();
    expect(
      copyModelArray(
        Array.from({ length: MODEL_ARRAY_LIMITS.maxItems }, (_, i) => i),
      ),
    ).toHaveLength(256);
  });
});
