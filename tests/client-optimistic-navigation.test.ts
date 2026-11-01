import { describe, expect, it } from 'vitest';
import { parseDirective } from '../packages/client/dist/index.js';
import { projectOptimistic } from '../packages/client/dist/optimistic.js';
import type { OptimisticDirective } from '../packages/client/dist/optimistic.js';

describe('nv:optimistic grammar', () => {
  it.each([
    [
      'nv:optimistic.toggle',
      'starred',
      { operation: 'toggle', field: 'starred' },
    ],
    [
      'nv:optimistic.set',
      'status:\x27done\x27',
      { operation: 'set', field: 'status', value: 'done' },
    ],
    [
      'nv:optimistic.set',
      'done:true',
      { operation: 'set', field: 'done', value: true },
    ],
    [
      'nv:optimistic.set',
      'owner:null',
      { operation: 'set', field: 'owner', value: null },
    ],
    [
      'nv:optimistic.increment',
      'likes',
      { operation: 'increment', field: 'likes', value: 1 },
    ],
    [
      'nv:optimistic.decrement',
      'stock:2.5',
      { operation: 'decrement', field: 'stock', value: 2.5 },
    ],
  ])('parses %s="%s"', (name, value, expected) => {
    expect(parseDirective(name, value)).toEqual({
      kind: 'optimistic',
      ...expected,
    });
  });

  it.each([
    ['nv:optimistic', 'likes'],
    ['nv:optimistic.eval', 'likes'],
    ['nv:optimistic.set', 'likes'],
    ['nv:optimistic.set', 'likes:alert(1)'],
    ['nv:optimistic.set', 'likes:"double"'],
    ['nv:optimistic.set', 'a.b:1'],
    ['nv:optimistic.toggle', 'done:true'],
    ['nv:optimistic.increment', 'likes:-1'],
    ['nv:optimistic.increment', 'likes:1e9'],
    ['nv:optimistic.set', '__proto__:1'],
  ])('rejects %s="%s"', (name, value) => {
    expect(() => parseDirective(name, value)).toThrow();
  });

  it('projects values and rejects type mismatches', () => {
    const toggle: OptimisticDirective = {
      kind: 'optimistic',
      operation: 'toggle',
      field: 'x',
    };
    const increment: OptimisticDirective = {
      kind: 'optimistic',
      operation: 'increment',
      field: 'x',
      value: 2,
    };
    expect(projectOptimistic(toggle, false)).toBe(true);
    expect(projectOptimistic(increment, 3)).toBe(5);
    expect(() => projectOptimistic(toggle, 'false')).toThrow(/boolean/);
    expect(() => projectOptimistic(increment, '3')).toThrow(/finite number/);
    expect(() =>
      projectOptimistic(increment, Number.MAX_VALUE * 1.5),
    ).toThrow();
  });
});

describe('nv:navigate grammar', () => {
  it('accepts the empty directive and hover prefetch only', () => {
    expect(parseDirective('nv:navigate', '')).toEqual({
      kind: 'navigate',
      prefetch: false,
      value: '',
    });
    expect(parseDirective('nv:navigate.hover', '')).toMatchObject({
      prefetch: true,
    });
    for (const [name, value] of [
      ['nv:navigate', '/elsewhere'],
      ['nv:navigate.eager', ''],
      ['nv:navigate.hover.once', ''],
    ])
      expect(() => parseDirective(name ?? '', value ?? '')).toThrow();
  });
});
