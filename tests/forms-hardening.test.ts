import { describe, expect, it } from 'vitest';
import { parse as parseQuery } from 'node:querystring';
import {
  FORM_ERROR,
  FormInputError,
  defaultInputLimits,
  formatPath,
  hardenInput,
  normalizeErrors,
  parseFormBody,
  parsePath,
  pickErrors,
  replaceErrors,
} from '../packages/forms/dist/index.js';

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof FormInputError) return error.code;
    throw error;
  }
  return undefined;
}

describe('hardenInput', () => {
  it('returns a detached plain JSON copy', () => {
    const source = { a: 'x', list: [1, true, null, { b: 'c' }] };
    const copy = hardenInput(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    const nullPrototype = Object.assign(Object.create(null) as object, {
      a: '1',
    });
    expect(Object.getPrototypeOf(hardenInput(nullPrototype))).toBe(
      Object.prototype,
    );
  });

  it('accepts empty null-prototype dictionary bases but not inherited behaviour', () => {
    // fast-querystring (Nest's Fastify urlencoded parser) uses this shape.
    function Empty() {}
    Empty.prototype = Object.create(null) as object;
    const dictionary = Object.create(Empty.prototype as object) as Record<
      string,
      unknown
    >;
    dictionary['name'] = 'Ada';
    expect(hardenInput(dictionary)).toEqual({ name: 'Ada' });
    expect(parseFormBody(dictionary)).toEqual({ name: 'Ada' });
    const inherited = Object.create({ isAdmin: true }) as Record<
      string,
      unknown
    >;
    inherited['name'] = 'Ada';
    expect(code(() => hardenInput(inherited))).toBe('TYPE');
  });

  it('refuses prototype-pollution keys at every depth', () => {
    for (const json of [
      '{"__proto__":{"admin":true}}',
      '{"a":{"constructor":{"prototype":{"admin":true}}}}',
      '{"a":[{"prototype":1}]}',
    ])
      expect(code(() => hardenInput(JSON.parse(json)))).toBe('FORBIDDEN_KEY');
    expect(Reflect.get({}, 'admin')).toBeUndefined();
  });

  it('refuses unsafe key syntax and symbol keys', () => {
    expect(code(() => hardenInput({ 'a.b': 1 }))).toBe('INVALID_KEY');
    expect(code(() => hardenInput({ 'a b': 1 }))).toBe('INVALID_KEY');
    expect(code(() => hardenInput({ ['x'.repeat(129)]: 1 }))).toBe(
      'INVALID_KEY',
    );
    expect(code(() => hardenInput({ [Symbol('s')]: 1 }))).toBe('INVALID_KEY');
  });

  it('refuses non-JSON types instead of coercing them (type confusion)', () => {
    class Model {
      name = 'x';
    }
    for (const value of [
      undefined,
      () => 1,
      Symbol('x'),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      new Model(),
      new String('x'),
      { nested: undefined },
      /regex/,
    ])
      expect(code(() => hardenInput(value))).toBe('TYPE');
  });

  it('never invokes getters', () => {
    let called = false;
    const value = {
      get secret() {
        called = true;
        return 'x';
      },
    };
    expect(code(() => hardenInput(value))).toBe('TYPE');
    expect(called).toBe(false);
  });

  it('refuses sparse and decorated arrays', () => {
    const sparse: unknown[] = [];
    sparse[3] = 'x';
    expect(code(() => hardenInput(sparse))).toBe('SPARSE_ARRAY');
    const decorated = Object.assign(['a'], { extra: true });
    expect(code(() => hardenInput(decorated))).toBe('SPARSE_ARRAY');
  });

  it('enforces depth, key, string, array and node bounds', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 9; index++) deep = { d: deep };
    expect(code(() => hardenInput(deep))).toBe('DEPTH');
    expect(
      code(() =>
        hardenInput(
          Object.fromEntries(
            Array.from({ length: 201 }, (_, i) => [`k${i}`, 1]),
          ),
        ),
      ),
    ).toBe('KEYS');
    expect(code(() => hardenInput('x'.repeat(10_001)))).toBe('STRING_LENGTH');
    expect(code(() => hardenInput(new Array(501).fill(0)))).toBe(
      'ARRAY_LENGTH',
    );
    expect(
      code(() =>
        hardenInput(new Array(100).fill([1, 2, 3, 4, 5]), { maxNodes: 300 }),
      ),
    ).toBe('NODES');
    expect(hardenInput('x'.repeat(20), { maxStringLength: 20 })).toHaveLength(
      20,
    );
    expect(defaultInputLimits).toEqual({
      maxDepth: 8,
      maxKeys: 200,
      maxStringLength: 10_000,
      maxArrayLength: 500,
      maxNodes: 5_000,
    });
  });

  it('validates limit configuration', () => {
    expect(() => hardenInput('x', { maxDepth: 0 })).toThrow(/maxDepth/);
    expect(() => hardenInput('x', { maxDepth: 1.5 })).toThrow(/maxDepth/);
    expect(() => hardenInput('x', { maxKeys: 1e9 })).toThrow(/maxKeys/);
    expect(() => hardenInput('x', { unknown: 1 } as never)).toThrow(/Unknown/);
  });

  it('does not echo submitted values in error messages', () => {
    try {
      hardenInput({ secret: 'hunter2'.repeat(2000) });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
      expect(error).toMatchObject({ code: 'STRING_LENGTH', path: 'secret' });
    }
  });
});

describe('parseFormBody', () => {
  it('expands flat bracket and dotted keys from node:querystring (Fastify)', () => {
    const body = parseQuery(
      'name=Ada&items%5B0%5D%5Bname%5D=Lamp&items%5B1%5D%5Bname%5D=Desk&tags%5B%5D=a&tags%5B%5D=b&meta.color=red&_csrf=secret',
    );
    expect(Object.getPrototypeOf(body)).toBeNull();
    expect(parseFormBody(body)).toEqual({
      name: 'Ada',
      items: [{ name: 'Lamp' }, { name: 'Desk' }],
      tags: ['a', 'b'],
      meta: { color: 'red' },
    });
  });

  it('accepts already-nested qs output (Express extended)', () => {
    expect(
      parseFormBody({
        name: 'Ada',
        items: [{ name: 'Lamp' }],
        _submission: 't',
      }),
    ).toEqual({ name: 'Ada', items: [{ name: 'Lamp' }] });
  });

  it('normalizes declared multi-value fields only', () => {
    expect(
      parseFormBody({ tags: 'a', name: 'x' }, { arrays: ['tags'] }),
    ).toEqual({ tags: ['a'], name: 'x' });
    expect(parseFormBody({ name: 'x' }, { arrays: ['tags'] })).toEqual({
      name: 'x',
      tags: [],
    });
    // A repeated scalar stays an array: the schema decides, nothing is picked silently.
    expect(parseFormBody(parseQuery('name=a&name=b'))).toEqual({
      name: ['a', 'b'],
    });
  });

  it('refuses prototype keys in flat and nested notation', () => {
    for (const query of [
      '__proto__%5Badmin%5D=1',
      'a%5B__proto__%5D%5Badmin%5D=1',
      'a.constructor.prototype=1',
      'constructor=1',
      'a%5Bprototype%5D=1',
    ])
      expect(code(() => parseFormBody(parseQuery(query)))).toBe(
        'FORBIDDEN_KEY',
      );
    expect(code(() => parseFormBody(JSON.parse('{"__proto__":"x"}')))).toBe(
      'FORBIDDEN_KEY',
    );
    expect(Reflect.get({}, 'admin')).toBeUndefined();
  });

  it('refuses malformed keys, conflicts, sparse and oversized indices', () => {
    expect(code(() => parseFormBody(parseQuery('a%5Bb=1')))).toBe(
      'INVALID_KEY',
    );
    expect(code(() => parseFormBody(parseQuery('a%5B%5D%5Bb%5D=1')))).toBe(
      'INVALID_KEY',
    );
    expect(code(() => parseFormBody(parseQuery('0=1')))).toBe('INVALID_KEY');
    expect(code(() => parseFormBody(parseQuery('a=1&a%5Bb%5D=2')))).toBe(
      'CONFLICT',
    );
    expect(code(() => parseFormBody(parseQuery('a%5B0%5D=1&a%5Bb%5D=2')))).toBe(
      'CONFLICT',
    );
    expect(code(() => parseFormBody(parseQuery('a%5B5%5D=1')))).toBe(
      'SPARSE_ARRAY',
    );
    expect(code(() => parseFormBody(parseQuery('a%5B999999%5D=1')))).toBe(
      'ARRAY_LENGTH',
    );
    expect(
      code(() =>
        parseFormBody(parseQuery('a%5Bb%5D%5Bc%5D%5Bd%5D=1'), {
          limits: { maxDepth: 3 },
        }),
      ),
    ).toBe('DEPTH');
  });

  it('refuses non-object bodies and oversized values', () => {
    for (const body of [undefined, null, 'a=1', ['a'], new Map()])
      expect(code(() => parseFormBody(body))).toBe('TYPE');
    expect(code(() => parseFormBody({ bio: 'x'.repeat(10_001) }))).toBe(
      'STRING_LENGTH',
    );
    expect(
      code(() =>
        parseFormBody(
          Object.fromEntries(
            Array.from({ length: 300 }, (_, i) => [`f${i}`, 'x']),
          ),
        ),
      ),
    ).toBe('KEYS');
  });
});

describe('error bags and paths', () => {
  it('formats and parses stable dotted paths', () => {
    expect(formatPath(['items', 0, 'name'])).toBe('items.0.name');
    expect(formatPath(['items', -1, 'name'])).toBe('items');
    expect(formatPath(['items', '__proto__', 'x'])).toBe('items');
    expect(formatPath([Symbol('x')])).toBe('');
    expect(parsePath('items.0.name')).toEqual(['items', 0, 'name']);
    expect(() => parsePath('a..b')).toThrow(FormInputError);
    expect(() => parsePath('a.__proto__')).toThrow(FormInputError);
  });

  it('normalizes untrusted error data', () => {
    expect(
      normalizeErrors({
        email: 'Bad email',
        '__proto__.x': ['hidden'],
        'items.0.name': ['Required', 'Required', 7],
        empty: [],
      }),
    ).toEqual({
      email: ['Bad email'],
      [FORM_ERROR]: ['hidden'],
      'items.0.name': ['Required'],
    });
    expect(normalizeErrors('x')).toEqual({});
    expect(normalizeErrors(['x'])).toEqual({});
  });

  it('picks and replaces entries per top-level field', () => {
    const current = {
      email: ['old'],
      name: ['keep'],
      'items.0.name': ['old item'],
    };
    expect(pickErrors(current, ['items'])).toEqual({
      'items.0.name': ['old item'],
    });
    expect(
      replaceErrors(current, { email: ['new'], name: ['ignored'] }, [
        'email',
        'items',
      ]),
    ).toEqual({ name: ['keep'], email: ['new'] });
  });
});
