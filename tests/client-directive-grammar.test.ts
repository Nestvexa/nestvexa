/**
 * Exhaustive grammar matrix for every nv:* directive. Each table is checked
 * against an independent oracle, so a parser change that accepts an ambiguous
 * combination, ignores modifier order or loses a value fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  parseDirective,
  parseEventDirective,
  parseLoadingDirective,
  parseModelDirective,
} from '../packages/client/dist/index.js';

/** Forward and reversed unit order; timing units stay adjacent to their value. */
function orders<T>(items: readonly T[]): T[][] {
  return items.length < 2 ? [[...items]] : [[...items], [...items].reverse()];
}
/** Every rotation of a token list; timing units stay adjacent to their value. */
function rotations<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [[...items]];
  return items.map((_, index) => [
    ...items.slice(index),
    ...items.slice(0, index),
  ]);
}
/** Key-order independent comparison key; undefined fields are absent. */
function canonical(value: object): string {
  return JSON.stringify(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
function subsets<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++)
    result.push(items.filter((_, index) => mask & (1 << index)));
  return result;
}

describe('event directive modifier matrix (click/submit/keydown)', () => {
  const flags = [
    'prevent',
    'stop',
    'self',
    'once',
    'ctrl',
    'alt',
    'shift',
    'meta',
  ] as const;
  const keys = [undefined, 'enter', 'arrow-down'] as const;
  const timings = [
    undefined,
    ['debounce'],
    ['debounce', '300ms'],
    ['throttle'],
    ['throttle', '500ms'],
  ] as const;
  const scopes = [undefined, 'window', 'document'] as const;
  const kinds = ['click', 'submit', 'keydown'] as const;

  it('accepts exactly the coherent combinations, independent of modifier order', () => {
    let accepted = 0;
    let rejected = 0;
    for (const kind of kinds)
      for (const enabled of subsets(flags))
        for (const key of keys)
          for (const timing of timings)
            for (const scope of scopes) {
              const units: string[][] = enabled.map((flag) => [flag]);
              if (key) units.push([key]);
              if (timing) units.push([...timing]);
              if (scope) units.push([scope]);
              const valid =
                (key === undefined || kind === 'keydown') &&
                (scope === undefined ||
                  (kind !== 'submit' &&
                    !enabled.includes('self') &&
                    !enabled.includes('stop')));
              for (const order of orders(units)) {
                const name = ['nv:' + kind, ...order.flat()].join('.');
                if (!valid) {
                  let message = '';
                  try {
                    parseEventDirective(name, 'save');
                  } catch (error) {
                    message = error instanceof Error ? error.message : '';
                  }
                  if (!/event modifier/.test(message))
                    expect.fail(`${name} should be rejected`);
                  rejected++;
                  continue;
                }
                const parsed = parseEventDirective(name, 'save');
                accepted++;
                const interval = (unit: string): number | undefined =>
                  timing?.[0] === unit
                    ? timing[1]
                      ? Number(timing[1].slice(0, -2))
                      : 250
                    : undefined;
                const expected: Record<string, unknown> = {
                  kind,
                  action: 'save',
                  ...Object.fromEntries(
                    flags.map((flag) => [flag, enabled.includes(flag)]),
                  ),
                  key:
                    key === 'enter'
                      ? 'Enter'
                      : key === 'arrow-down'
                        ? 'ArrowDown'
                        : undefined,
                  debounceMs: interval('debounce'),
                  throttleMs: interval('throttle'),
                  scope,
                };
                if (canonical(parsed) !== canonical(expected))
                  expect({ ...parsed }, name).toEqual(expected);
                // The generic parser routes to the same closed grammar; a bare
                // click/submit keeps its historical { kind, value } shape.
                const routed = parseDirective(name, 'save');
                if (
                  canonical(routed) !==
                  canonical(
                    order.length || kind === 'keydown'
                      ? parsed
                      : { kind, value: 'save' },
                  )
                )
                  expect.fail(`${name} routes to a different grammar`);
              }
            }
    expect(accepted).toBeGreaterThan(10_000);
    expect(rejected).toBeGreaterThan(10_000);
  });

  it.each([
    ['nv:click.prevent.prevent', 'duplicate flag'],
    ['nv:keydown.enter.escape', 'two keys'],
    ['nv:click.debounce.throttle', 'two schedulers'],
    ['nv:click.debounce.debounce', 'duplicate scheduler'],
    ['nv:click.debounce.0ms', 'zero interval'],
    ['nv:click.throttle.60001ms', 'interval above bound'],
    ['nv:click.300ms', 'orphan interval'],
    ['nv:click.debounce.1.5ms', 'fractional interval'],
    ['nv:click.debounce.300', 'interval without unit'],
    ['nv:click.window.document', 'two scopes'],
    ['nv:click.window.window', 'duplicate scope'],
    ['nv:click.outside', 'unknown modifier'],
    ['nv:click.passive', 'unknown modifier'],
    ['nv:click.capture', 'unknown modifier'],
    ['nv:click.Prevent', 'case-sensitive modifier'],
    ['nv:click.', 'empty modifier'],
    ['nv:click..prevent', 'empty modifier'],
    ['nv:dblclick', 'unsupported event'],
    ['nv:input', 'unsupported event'],
    ['click', 'missing namespace'],
  ])('rejects %s (%s)', (name) => {
    expect(() => parseEventDirective(name, 'save')).toThrow();
  });

  it.each([
    'save()',
    'save;alert(1)',
    'a.b',
    'constructor',
    '__proto__',
    'prototype',
    'x y',
    '',
    '1save',
    '$save',
    'javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
    'a'.repeat(65),
  ])('never treats %j as an executable action expression', (value) => {
    for (const name of ['nv:click', 'nv:submit.prevent', 'nv:keydown.enter'])
      expect(() => parseDirective(name, value)).toThrow(/identifier/);
  });
});

describe('model directive modifier matrix', () => {
  const modes = [undefined, 'defer', 'live', 'blur', 'change', 'lazy'] as const;
  const casts = [undefined, 'number', 'boolean'] as const;
  const timings = [
    undefined,
    ['debounce'],
    ['debounce', '300ms'],
    ['throttle'],
    ['throttle', '500ms'],
  ] as const;

  it('derives one mode, cast and timer for every coherent combination', () => {
    let checked = 0;
    for (const mode of modes)
      for (const cast of casts)
        for (const timing of timings) {
          const units: string[][] = [];
          if (mode) units.push([mode]);
          if (cast) units.push([cast]);
          if (timing) units.push([...timing]);
          const valid =
            timing === undefined || mode === undefined || mode === 'live';
          for (const order of rotations(units)) {
            const name = ['nv:model', ...order.flat()].join('.');
            checked++;
            if (!valid) {
              expect(() => parseModelDirective(name, 'field'), name).toThrow();
              continue;
            }
            const parsed = parseModelDirective(name, 'field');
            const expectedMode =
              mode === 'lazy'
                ? 'change'
                : (mode ?? (timing === undefined ? 'defer' : 'live'));
            expect(parsed.mode, name).toBe(expectedMode);
            expect(parsed.cast).toBe(cast ?? 'auto');
            expect(parsed.field).toBe('field');
            const debounce =
              timing?.[0] === 'debounce'
                ? timing[1] === '300ms'
                  ? 300
                  : 250
                : expectedMode === 'live' && timing === undefined
                  ? 150
                  : undefined;
            expect(parsed.debounceMs, name).toBe(debounce);
            expect(parsed.throttleMs).toBe(
              timing?.[0] === 'throttle'
                ? timing[1] === '500ms'
                  ? 500
                  : 250
                : undefined,
            );
            expect(parseDirective(name, 'field')).toEqual({
              kind: 'model',
              value: 'field',
            });
          }
        }
    expect(checked).toBeGreaterThan(200);
  });

  it.each([
    'nv:model.live.blur',
    'nv:model.lazy.change',
    'nv:model.number.boolean',
    'nv:model.debounce.throttle',
    'nv:model.live.live',
    'nv:model.prevent',
    'nv:model.enter',
    'nv:model.once',
    'nv:model.window',
    'nv:model.debounce.0ms',
    'nv:model.throttle.60001ms',
    'nv:model.fill',
    'nv:model.',
  ])('rejects %s', (name) => {
    expect(() => parseDirective(name, 'field')).toThrow();
  });

  it.each(['user.name', 'items[0]', 'a b', '__proto__', 'name()', ''])(
    'rejects model path or expression %j',
    (value) => {
      expect(() => parseDirective('nv:model.live', value)).toThrow();
    },
  );
});

describe('loading, target and offline effect matrix', () => {
  const effects = [
    ['', ''],
    ['.class', 'busy pending'],
    ['.attr', 'disabled'],
    ['.attr', 'aria-busy'],
  ] as const;
  const delays = [
    ['', undefined],
    ['.delay', 200],
    ['.delay.1ms', 1],
    ['.delay.750ms', 750],
    ['.delay.10000ms', 10_000],
  ] as const;

  it.each(
    effects.flatMap(([mode, value]) =>
      ['', '.remove'].flatMap((remove) =>
        delays.map(
          ([delay, ms]) =>
            [`nv:loading${mode}${remove}${delay}`, value, ms] as const,
        ),
      ),
    ),
  )('%s=%j parses with delay %s', (name, value, ms) => {
    const parsed = parseLoadingDirective(name, value);
    expect(parsed.kind).toBe('loading');
    expect(parsed.remove).toBe(name.includes('.remove'));
    expect(parsed.delayMs).toBe(ms);
    expect(parseDirective(name, value)).toEqual(
      name === 'nv:loading' ? { kind: 'loading', value: '' } : parsed,
    );
    const offline = name.replace('nv:loading', 'nv:offline');
    if (ms === undefined)
      expect(parseDirective(offline, value)).toMatchObject({
        kind: 'offline',
        effect: parsed,
      });
    else expect(() => parseDirective(offline, value)).toThrow();
  });

  it.each([
    ['nv:loading.delay.remove', ''],
    ['nv:loading.remove.class', 'busy'],
    ['nv:loading.delay.0ms', ''],
    ['nv:loading.delay.10001ms', ''],
    ['nv:loading.delay.2s', ''],
    ['nv:loading.delay.delay', ''],
    ['nv:loading.delay', 'save'],
    ['nv:loading.class.delay', ''],
    ['nv:loading.attr.delay', 'onclick'],
    ['nv:loading.attr', 'style'],
    ['nv:loading.attr', 'href'],
    ['nv:loading.class', 'a:b'],
    ['nv:loading.duration', ''],
    ['nv:offline.delay', ''],
    ['nv:offline.bogus', ''],
  ])('rejects %s=%j', (name, value) => {
    expect(() => parseDirective(name, value)).toThrow();
  });

  it('parses targets as identifiers plus the explicit synchronization name', () => {
    expect(parseDirective('nv:target', 'save, $sync')).toEqual({
      kind: 'target',
      actions: ['save', '$sync'],
    });
    for (const value of ['', 'save,save', 'save()', '$other', 'a.b'])
      expect(() => parseDirective('nv:target', value)).toThrow();
  });
});

describe('remaining directive grammar table', () => {
  it.each([
    [
      'nv:poll',
      'refresh',
      { kind: 'poll', value: 'refresh', intervalMs: 2500 },
    ],
    [
      'nv:poll.1000ms',
      'refresh',
      { kind: 'poll', value: 'refresh', intervalMs: 1000 },
    ],
    [
      'nv:poll.5s',
      'refresh',
      { kind: 'poll', value: 'refresh', intervalMs: 5000 },
    ],
    ['nv:intersect', 'load', { kind: 'intersect', value: 'load', once: false }],
    [
      'nv:intersect.once',
      'load',
      { kind: 'intersect', value: 'load', once: true },
    ],
    ['nv:init', 'load', { kind: 'init', value: 'load' }],
    [
      'nv:init.visible',
      'load',
      { kind: 'init', value: 'load', timing: 'visible' },
    ],
    ['nv:init.idle', 'load', { kind: 'init', value: 'load', timing: 'idle' }],
    ['nv:navigate', '', { kind: 'navigate', prefetch: false, value: '' }],
    ['nv:navigate.hover', '', { kind: 'navigate', prefetch: true, value: '' }],
    [
      'nv:confirm',
      'Delete this item?',
      { kind: 'confirm', message: 'Delete this item?' },
    ],
    [
      'nv:optimistic.increment',
      'count:2',
      { kind: 'optimistic', operation: 'increment', field: 'count', value: 2 },
    ],
    [
      'nv:optimistic.set',
      "label:'Saving'",
      {
        kind: 'optimistic',
        operation: 'set',
        field: 'label',
        value: 'Saving',
      },
    ],
    [
      'nv:optimistic.toggle',
      'open',
      { kind: 'optimistic', operation: 'toggle', field: 'open' },
    ],
    ['nv:sort', 'reorder', { kind: 'sort', value: 'reorder' }],
    ['nv:sort.item', 'row-1', { kind: 'sort-item', id: 'row-1' }],
    ['nv:sort.handle', '', { kind: 'sort-handle' }],
    ['nv:stream', 'answer', { kind: 'stream', id: 'answer', append: false }],
    [
      'nv:stream.append',
      'answer',
      { kind: 'stream', id: 'answer', append: true },
    ],
    ['nv:upload', 'avatar', { kind: 'upload', role: 'input', field: 'avatar' }],
    [
      'nv:upload.progress',
      'avatar',
      { kind: 'upload', role: 'progress', field: 'avatar' },
    ],
    ['nv:ignore', '', { kind: 'ignore', value: '' }],
    ['nv:ignore.self', '', { kind: 'ignore', self: true, value: '' }],
    ['nv:replace', '', { kind: 'replace', self: false }],
    ['nv:replace.self', '', { kind: 'replace', self: true }],
    ['nv:text', 'title', { kind: 'text', field: 'title' }],
    ['nv:show', 'open', { kind: 'show', field: 'open' }],
    ['nv:dirty', '', { kind: 'dirty' }],
    ['nv:dirty', 'name', { kind: 'dirty', field: 'name' }],
    ['nv:cloak', '', { kind: 'cloak' }],
    ['nv:ref', 'panel', { kind: 'ref', name: 'panel' }],
    [
      'nv:current',
      'active',
      { kind: 'current', exact: false, tokens: ['active'] },
    ],
    [
      'nv:current.exact',
      'active',
      { kind: 'current', exact: true, tokens: ['active'] },
    ],
    [
      'nv:transition.enter',
      'fade',
      { kind: 'transition', stage: 'enter', tokens: ['fade'] },
    ],
  ])('%s=%j parses to a closed configuration', (name, value, expected) => {
    expect(parseDirective(name, value)).toMatchObject(expected);
  });

  it.each([
    ['nv:poll.999ms', 'refresh'],
    ['nv:poll.3600001ms', 'refresh'],
    ['nv:poll.visible', 'refresh'],
    ['nv:poll.0s', 'refresh'],
    ['nv:intersect.twice', 'load'],
    ['nv:init.once', 'load'],
    ['nv:init.lazy', 'load'],
    ['nv:navigate', '/path'],
    ['nv:navigate.prefetch', ''],
    ['nv:confirm', ''],
    ['nv:confirm', 'x'.repeat(1025)],
    ['nv:confirm', 'Bell\u0007'],
    ['nv:confirm.prevent', 'Sure?'],
    ['nv:optimistic', 'count'],
    ['nv:optimistic.increment', 'count:-1'],
    ['nv:optimistic.set', 'count'],
    ['nv:optimistic.set', 'count:alert(1)'],
    ['nv:optimistic.toggle', 'open:true'],
    ['nv:sort.item', '__proto__'],
    ['nv:sort.item', 'has space'],
    ['nv:sort.handle', 'x'],
    ['nv:sort.grid', 'reorder'],
    ['nv:stream.html', 'answer'],
    ['nv:upload.multiple', 'avatar'],
    ['nv:ignore', 'x'],
    ['nv:ignore.children', ''],
    ['nv:replace', 'x'],
    ['nv:replace.children', ''],
    ['nv:text', 'user.name'],
    ['nv:text.html', 'title'],
    ['nv:show', ''],
    ['nv:show.important', 'open'],
    ['nv:cloak', 'x'],
    ['nv:ref', 'a b'],
    ['nv:bind', 'onclick:handler'],
    ['nv:bind', 'style:css'],
    ['nv:bind', 'srcdoc:html'],
    ['nv:bind', 'href'],
    ['nv:bind', 'href:a:b'],
    ['nv:bind.prop', 'title:name'],
    ['nv:current', 'a:b'],
    ['nv:current.prefix', 'active'],
    ['nv:transition.middle', 'fade'],
    ['nv:transition.enter', 'x;y'],
    ['nv:html', 'content'],
    ['nv:on', 'click'],
    ['nv:eval', 'x'],
    ['nv:', ''],
    ['x-on:click', 'save'],
  ])('rejects %s=%j explicitly', (name, value) => {
    expect(() => parseDirective(name, value)).toThrow();
  });

  it('binds only the allowlisted attributes to public state fields', () => {
    for (const attribute of [
      'title',
      'aria-label',
      'aria-expanded',
      'aria-disabled',
      'href',
      'src',
      'disabled',
      'readonly',
    ])
      expect(parseDirective('nv:bind', `${attribute}:field`)).toMatchObject({
        kind: 'bind',
      });
  });
});
