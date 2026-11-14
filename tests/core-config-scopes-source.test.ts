import { describe, expect, it } from 'vitest';
import { NestvexaConfigError } from '../packages/core/src/errors.js';
import {
  mergeNestvexaOptions,
  normalizeOptions,
} from '../packages/core/src/config.js';

// Source-level tests for the `views.namespaces` / `views.themes` directory
// maps in packages/core/src/config.ts. packages/core/src/config.ts is a
// high-risk module with a per-file 90% branch gate (docs/testing/coverage.md);
// the behavioural view-namespace suites import the built package, which that
// gate cannot see.

function issuesOf(input: unknown): { path: string; expected: string }[] {
  try {
    normalizeOptions(input);
  } catch (error) {
    if (!(error instanceof NestvexaConfigError)) throw error;
    return error.issues.map(({ path, expected }) => ({ path, expected }));
  }
  throw new Error('expected a configuration error');
}

const paths = (input: unknown) => issuesOf(input).map((issue) => issue.path);

describe.each(['namespaces', 'themes'] as const)('views.%s', (field) => {
  const path = `views.${field}`;
  const views = (value: unknown) => ({ views: { [field]: value } });

  it('is omitted when not configured', () => {
    expect(field in normalizeOptions({}).views).toBe(false);
  });

  it('copies valid entries into a frozen null-prototype map', () => {
    const source = { admin: 'src/admin/views', 'dark-mode': 'themes/dark' };
    const normalized = normalizeOptions(views(source)).views[field];
    expect(normalized).toEqual(source);
    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(Object.isFrozen(normalized)).toBe(true);
    // A later mutation of the input does not reach the normalized copy.
    source.admin = 'elsewhere';
    expect(normalized?.admin).toBe('src/admin/views');
  });

  it('accepts a null-prototype input object and an empty map', () => {
    const input = Object.assign(Object.create(null) as object, { a: 'x' });
    expect(normalizeOptions(views(input)).views[field]).toEqual({ a: 'x' });
    expect(normalizeOptions(views({})).views[field]).toEqual({});
  });

  it.each([
    ['a string', 'admin'],
    ['null', null],
    ['an array', ['admin']],
    ['a Map', new Map([['admin', 'x']])],
    ['a class instance', new (class Directories {})()],
  ])('rejects %s', (_, value) => {
    expect(issuesOf(views(value))).toEqual([
      {
        path,
        expected: 'an object of lowercase name -> directory strings',
      },
    ]);
  });

  it('rejects more than 64 entries', () => {
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`n${index}`, 'dir']),
    );
    expect(issuesOf(views(many))).toEqual([
      { path, expected: 'at most 64 entries' },
    ]);
    const limit = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`n${index}`, 'dir']),
    );
    expect(
      Object.keys(normalizeOptions(views(limit)).views[field] ?? {}),
    ).toHaveLength(64);
  });

  it.each([
    'Admin',
    '1admin',
    '-admin',
    'ad min',
    'a'.repeat(65),
    'constructor',
    'prototype',
  ])('rejects the name %j', (name) => {
    expect(issuesOf(views({ [name]: 'dir' }))).toEqual([
      { path, expected: 'lowercase names such as "admin" or "dark-mode"' },
    ]);
  });

  it('rejects symbol keys', () => {
    expect(paths(views({ [Symbol('admin')]: 'dir' }))).toEqual([path]);
  });

  it('does not run accessors', () => {
    let read = false;
    const input = {
      get admin() {
        read = true;
        return 'dir';
      },
    };
    expect(issuesOf(views(input))).toEqual([
      {
        path: `${path}.admin`,
        expected: 'a data property (accessors are not read)',
      },
    ]);
    expect(read).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a NUL byte', 'views\0/admin'],
    ['a number', 42],
  ])('rejects %s as a directory', (_, directory) => {
    expect(paths(views({ admin: directory }))).toEqual([`${path}.admin`]);
  });

  it('reports every invalid entry, not just the first', () => {
    expect(
      paths(views({ Admin: 'a', ok: 'b', bad: '', prototype: 'c' })),
    ).toEqual([path, `${path}.bad`, path]);
  });

  it('is replaced as a whole by a later merge layer', () => {
    const merged = mergeNestvexaOptions(
      views({ admin: 'a', shop: 'b' }),
      views({ admin: 'c' }),
    );
    expect(normalizeOptions(merged).views[field]).toEqual({ admin: 'c' });
  });

  it('is validated with layer paths when merged', () => {
    let issues: string[] = [];
    try {
      mergeNestvexaOptions({ views: { root: 'x' } }, views({ Bad: 'x' }));
    } catch (error) {
      if (error instanceof NestvexaConfigError)
        issues = error.issues.map((issue) => issue.path);
    }
    expect(issues).toEqual([path]);
  });
});

it('keeps namespaces and themes independent', () => {
  const views = normalizeOptions({
    views: { namespaces: { admin: 'a' }, themes: { dark: 'd' } },
  }).views;
  expect(views.namespaces).toEqual({ admin: 'a' });
  expect(views.themes).toEqual({ dark: 'd' });
});
