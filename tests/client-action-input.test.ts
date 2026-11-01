import { describe, expect, it } from 'vitest';
import { cloneActionInput } from '../packages/client/src/action-input.js';

describe('bounded action input trust boundary', () => {
  it('detaches and recursively freezes JSON without freezing caller-owned data', () => {
    const original = {
      ids: ['a', 'b'],
      nested: { nullable: null, enabled: true, value: 2 },
    };
    const copied = cloneActionInput(original);
    original.ids.reverse();
    original.nested.value = 3;
    expect(copied).toEqual({
      ids: ['a', 'b'],
      nested: { nullable: null, enabled: true, value: 2 },
    });
    expect(Object.isFrozen(copied)).toBe(true);
    if (!copied || typeof copied !== 'object' || Array.isArray(copied))
      throw new Error('Expected record');
    expect(Object.isFrozen(Reflect.get(copied, 'ids'))).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });
  it.each([null, false, true, 0, -1.25, '', 'مرحبا <script>'])(
    'preserves literal JSON primitive %j',
    (input) => {
      expect(cloneActionInput(input)).toBe(input);
    },
  );
  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('key'),
    () => 1,
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array(1),
    new (class Domain {
      value = 1;
    })(),
  ])('rejects non-JSON input %s', (input) => {
    expect(() => cloneActionInput(input)).toThrow('Action input');
  });
  it('rejects accessors and toJSON without executing them', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        reads++;
        return 'secret';
      },
    });
    expect(() => cloneActionInput(getter)).toThrow();
    expect(() =>
      cloneActionInput({
        toJSON() {
          reads++;
          return {};
        },
      }),
    ).toThrow();
    expect(reads).toBe(0);
  });
  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects nested dangerous key %s',
    (key) => {
      expect(() =>
        cloneActionInput({ nested: JSON.parse(`{"${key}":"unsafe"}`) }),
      ).toThrow();
    },
  );
  it('rejects cycles, sparse/augmented arrays, symbols and hidden properties', () => {
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    const augmented: unknown[] = ['a'];
    Object.defineProperty(augmented, 'extra', { value: true });
    for (const input of [
      cyclic,
      Array(2),
      augmented,
      { [Symbol('secret')]: true },
      Object.defineProperty({}, 'hidden', { value: 1 }),
    ])
      expect(() => cloneActionInput(input)).toThrow();
  });
  it('bounds depth, nodes and actual JSON UTF-8 bytes', () => {
    let nested: unknown = null;
    for (let i = 0; i < 10; i++) nested = { nested };
    for (const input of [
      nested,
      Array(1000).fill(1),
      'x'.repeat(16383),
      '界'.repeat(6000),
    ])
      expect(() => cloneActionInput(input)).toThrow();
    expect(
      cloneActionInput({
        ids: Array.from({ length: 200 }, (_, index) =>
          String(index).padEnd(64, 'x'),
        ),
      }),
    ).toBeDefined();
  });
  it('allows independent aliases to the same acyclic object with detached copies', () => {
    const shared = { id: 'a' };
    expect(cloneActionInput({ first: shared, second: shared })).toEqual({
      first: { id: 'a' },
      second: { id: 'a' },
    });
  });
});
