import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  InertiaConfigurationError,
  InertiaProp,
  InertiaRedirectError,
  InertiaRequestError,
  InertiaSerializationError,
  InertiaValidationException,
  always,
  assertSafeRedirect,
  defer,
  escapeJsonForScript,
  flattenValidationErrors,
  merge,
  once,
  optional,
  parseInertiaRequest,
  resolveOptions,
  scroll,
  toJsonValue,
} from '../packages/inertia/dist/index.js';

const json = { preserveBigIntegers: false, maxDepth: 64 };

describe('page JSON serialization', () => {
  it('escapes script-terminating sequences without HTML entities and round-trips', () => {
    const value = {
      text: '</script><script>alert(1)</script><!-- & \u2028\u2029 /',
    };
    const escaped = escapeJsonForScript(JSON.stringify(value));
    expect(escaped).not.toMatch(/[<>&\u2028\u2029]/);
    expect(escaped).not.toMatch(/[^\\]\//);
    expect(escaped).not.toContain('&lt;');
    expect(escaped).toContain('\\u003c\\/script\\u003e');
    expect(JSON.parse(escaped)).toStrictEqual(value);
  });

  it('defines Date, undefined and array-hole handling', () => {
    const result = toJsonValue(
      {
        when: new Date(0),
        missing: undefined,
        list: [1, undefined, 3],
        nested: { toJSON: () => 'custom' },
      },
      json,
    );
    expect(result.value).toStrictEqual({
      when: '1970-01-01T00:00:00.000Z',
      list: [1, null, 3],
      nested: 'custom',
    });
    expect(result.bigint).toBe(false);
  });

  it.each([
    ['functions', { fn: () => 1 }],
    ['symbols', { s: Symbol('x') }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['invalid dates', { d: new Date('nope') }],
    ['Maps', { m: new Map() }],
    ['Sets', { s: new Set() }],
    ['Promises', { p: Promise.resolve(1) }],
    ['Errors', { e: new Error('secret') }],
    ['bigint without opt-in', { b: 1n }],
  ])('rejects %s', (_label, value) => {
    expect(() => toJsonValue(value, json)).toThrow(InertiaSerializationError);
  });

  it('rejects cycles but accepts shared references', () => {
    const shared = { a: 1 };
    expect(toJsonValue({ x: shared, y: shared }, json).value).toStrictEqual({
      x: { a: 1 },
      y: { a: 1 },
    });
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => toJsonValue(cycle, json)).toThrow(/circular/);
  });

  it('bounds depth and never echoes offending values', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 70; i++) deep = { deep };
    expect(() => toJsonValue(deep, json)).toThrow(/maximum depth/);
    try {
      toJsonValue({ password: () => 'hunter2' }, json);
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
      expect((error as InertiaSerializationError).path).toBe('password');
    }
  });

  it('encodes bigint with the upstream marker when enabled', () => {
    expect(
      toJsonValue(
        { id: 900719925474099988n },
        { ...json, preserveBigIntegers: true },
      ),
    ).toStrictEqual({
      value: { id: { $bigint: '900719925474099988' } },
      bigint: true,
    });
  });

  it('rejects own __proto__ keys in data', () => {
    expect(() =>
      toJsonValue(JSON.parse('{"__proto__":{"polluted":true}}'), json),
    ).toThrow(/forbidden key/);
  });
});

describe('request header parsing', () => {
  const request = (headers: Record<string, unknown>, method = 'GET') => ({
    method,
    headers,
  });

  it('parses the documented headers on Inertia requests', () => {
    const info = parseInertiaRequest(
      request({
        'x-inertia': 'true',
        'x-inertia-version': 'abc',
        'x-inertia-partial-component': 'Users/Index',
        'x-inertia-partial-data': 'users,,auth.user',
        'x-inertia-partial-except': 'companies',
        'x-inertia-reset': 'users',
        'x-inertia-except-once-props': 'plans',
        'x-inertia-error-bag': 'createUser',
        'x-inertia-infinite-scroll-merge-intent': 'prepend',
        purpose: 'prefetch',
      }),
    );
    expect(info).toStrictEqual({
      inertia: true,
      method: 'GET',
      version: 'abc',
      partialComponent: 'Users/Index',
      only: ['users', 'auth.user'],
      except: ['companies'],
      reset: ['users'],
      exceptOnce: ['plans'],
      errorBag: 'createUser',
      mergeIntent: 'prepend',
      prefetch: true,
    });
  });

  it('treats only X-Inertia: true as an Inertia request and ignores partial headers otherwise', () => {
    for (const value of ['false', '1', '', 'yes'])
      expect(parseInertiaRequest(request({ 'x-inertia': value })).inertia).toBe(
        false,
      );
    const info = parseInertiaRequest(
      request({ 'x-inertia-partial-data': '__proto__' }),
    );
    expect(info.only).toBeUndefined();
  });

  it.each([
    ['repeated header values', { 'x-inertia-partial-data': ['a', 'b'] }],
    ['non-string values', { 'x-inertia-version': 42 }],
    ['oversized lists', { 'x-inertia-partial-data': 'a,'.repeat(3000) }],
    [
      'too many entries',
      {
        'x-inertia-partial-data': Array.from(
          { length: 200 },
          (_, i) => `p${i}`,
        ).join(','),
      },
    ],
    ['oversized entries', { 'x-inertia-partial-except': 'x'.repeat(300) }],
    [
      'prototype segments',
      { 'x-inertia-partial-data': 'constructor.prototype' },
    ],
    ['__proto__ once keys', { 'x-inertia-except-once-props': '__proto__' }],
    ['empty path segments', { 'x-inertia-reset': 'a..b' }],
    ['control characters', { 'x-inertia-partial-component': 'A\u0000B' }],
    [
      'unknown merge intents',
      { 'x-inertia-infinite-scroll-merge-intent': 'sideways' },
    ],
    ['dotted error bags', { 'x-inertia-error-bag': 'a.b' }],
    ['oversized versions', { 'x-inertia-version': 'v'.repeat(600) }],
  ])('rejects %s with InertiaRequestError', (_label, headers) => {
    expect(() =>
      parseInertiaRequest(request({ 'x-inertia': 'true', ...headers })),
    ).toThrow(InertiaRequestError);
  });
});

describe('redirect policy', () => {
  const policy = { allowedOrigins: new Set(['https://pay.example.com']) };
  it.each([
    '/dashboard',
    '/a?b=c#d',
    '/%2F%2Fevil.com',
    'https://pay.example.com/checkout',
  ])('allows %s', (url) => {
    expect(assertSafeRedirect(url, policy)).toBe(url);
  });
  it.each([
    '//evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    'https://evil.com',
    'http://pay.example.com/insecure-scheme',
    'https://user:pass@pay.example.com/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    ' /leading-space',
    '/header\r\nSet-Cookie: a=b',
    'relative/path',
    '',
    'x'.repeat(3000),
  ])('rejects %j', (url) => {
    expect(() => assertSafeRedirect(url, policy)).toThrow(InertiaRedirectError);
  });
});

describe('prop types', () => {
  it('are immutable: modifiers return new instances', () => {
    const base = merge([1]);
    const prepended = base.prepend();
    expect(prepended).not.toBe(base);
    expect(prepended).toBeInstanceOf(InertiaProp);
    expect(InertiaProp.state(base).append).toBe(true);
    expect(InertiaProp.state(prepended).append).toBe(false);
    const lazy = once(() => 1);
    expect(InertiaProp.state(lazy.as('k')).onceKey).toBe('k');
    expect(InertiaProp.state(lazy).onceKey).toBeUndefined();
  });

  it('only enable once behaviour through once()', () => {
    expect(InertiaProp.state(optional(() => 1).as('x')).once).toBe(false);
    expect(
      InertiaProp.state(optional(() => 1).once({ as: 'x', until: 5 })).once,
    ).toBe(true);
    expect(InertiaProp.state(defer(() => 1).once()).once).toBe(true);
  });

  it.each([
    [
      'optional() without a function',
      () => optional(1 as unknown as () => number),
    ],
    ['defer() without a function', () => defer('x' as unknown as () => string)],
    ['defer() with a comma group', () => defer(() => 1, 'a,b')],
    ['once() with a negative expiry', () => once(() => 1).until(-1)],
    ['once() with an invalid date', () => once(() => 1).until(new Date('x'))],
    [
      'merge paths with prototype segments',
      () => merge({}).append('constructor.x'),
    ],
    [
      'scroll() without metadata',
      () => scroll([], undefined as unknown as { metadata: never }),
    ],
    ['once keys named __proto__', () => once(() => 1).as('__proto__')],
  ])('rejects %s', (_label, build) => {
    expect(build).toThrow(InertiaConfigurationError);
  });

  it('accepts always() with eager or lazy values', () => {
    expect(always(1).kind).toBe('always');
    expect(always(() => 1).kind).toBe('always');
  });
});

describe('validation helpers', () => {
  it('flattens nested class-validator style errors', () => {
    expect(
      flattenValidationErrors([
        { property: 'name', constraints: { a: 'A', b: 'B' } },
        {
          property: 'address',
          children: [{ property: 'city', constraints: { c: 'C' } }],
        },
      ]),
    ).toStrictEqual({ name: ['A', 'B'], 'address.city': ['C'] });
  });

  it('rejects unsafe error shapes', () => {
    expect(
      () =>
        new InertiaValidationException(
          JSON.parse('{"__proto__":"x"}') as Record<string, string>,
        ),
    ).toThrow();
    expect(
      () =>
        new InertiaValidationException({ name: 1 } as unknown as Record<
          string,
          string
        >),
    ).toThrow();
    expect(
      () => new InertiaValidationException({ name: 'x' }, { bag: 'a.b' }),
    ).toThrow();
  });
});

describe('options', () => {
  it('applies documented defaults', () => {
    const options = resolveOptions();
    expect(options.defaultApp).toBe('default');
    expect(options.namespaceVersions).toBe(false);
    expect(options.exposeSharedPropKeys).toBe(true);
    expect(options.encryptHistory).toBe(false);
    expect(options.preserveBigIntegers).toBe(false);
    expect(options.allErrors).toBe(false);
    expect(options.fallback).toBe('/');
    expect(options.limits).toStrictEqual({
      headerLength: 4096,
      listEntries: 128,
      entryLength: 256,
    });
    expect(options.depth).toBe(64);
    expect(options.apps.get('default')?.id).toBe('app');
  });
});
