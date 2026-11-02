import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { I18n, I18nError, loadCatalogs } from '../packages/i18n/dist/index.js';

const base = { locales: ['en', 'ar'], defaultLocale: 'en', timeZone: 'UTC' };
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nv-i18n-'));
  directories.push(directory);
  return directory;
}

describe('catalog prototype and shape safety', () => {
  it.each([
    ['own __proto__ from JSON.parse', '{"__proto__":{"polluted":"yes"}}'],
    ['constructor key', '{"constructor":{"prototype":"x"}}'],
    ['nested prototype key', '{"a":{"prototype":"x"}}'],
    ['array value', '{"a":["x"]}'],
    ['number leaf', '{"a":1}'],
    ['dotted key', '{"a.b":"x"}'],
  ])('rejects %s and never pollutes Object.prototype', (_label, json) => {
    const tree: unknown = JSON.parse(json);
    expect(
      () => new I18n({ ...base, catalogs: { en: { common: tree as object } } }),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG' }));
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('rejects accessors, class instances, symbols, invalid messages and prototype namespaces', () => {
    let reads = 0;
    const getter = Object.defineProperty({}, 'title', {
      enumerable: true,
      get() {
        reads++;
        return 'x';
      },
    });
    class Messages {
      title = 'x';
    }
    for (const common of [
      getter,
      new Messages(),
      { [Symbol('s')]: 'x' },
      { title: '{count, plural, one {x}}' },
    ])
      expect(() => new I18n({ ...base, catalogs: { en: { common } } })).toThrow(
        I18nError,
      );
    expect(reads).toBe(0);
    const namespaces: unknown = JSON.parse('{"__proto__":{"a":"b"}}');
    expect(
      () =>
        new I18n({
          ...base,
          catalogs: { en: namespaces as Record<string, unknown> },
        }),
    ).toThrow(I18nError);
  });
  it('bounds catalog depth, message size and total entries', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let level = 0; level < 20; level++) deep = { n: deep };
    expect(
      () => new I18n({ ...base, catalogs: { en: { common: deep } } }),
    ).toThrow(/deep/);
    expect(
      () =>
        new I18n({
          ...base,
          catalogs: { en: { common: { big: 'x'.repeat(9000) } } },
        }),
    ).toThrow(/long/);
    const many: Record<string, string> = {};
    for (let index = 0; index < 100_001; index++) many[`k${index}`] = 'v';
    expect(
      () => new I18n({ ...base, catalogs: { en: { common: many } } }),
    ).toThrow(/too many/);
  });
  it('treats lookups as own-property map reads; prototype names cannot resolve', () => {
    const i18n = new I18n({
      ...base,
      catalogs: { en: { common: { title: 'T' } } },
    });
    expect(() => i18n.t('en', 'toString')).not.toThrow();
    expect(i18n.t('en', 'toString')).toBe('toString');
    expect(i18n.has('en', 'hasOwnProperty')).toBe(false);
    expect(() => i18n.t('en', 'common:__proto__')).toThrow(I18nError);
  });
});

describe('request-derived locale injection', () => {
  const i18n = new I18n({ ...base, catalogs: {} });
  it.each([
    'ar<script>',
    'en-US\r\nSet-Cookie: a=b',
    '../../etc/passwd',
    'constructor',
    '__proto__',
    'toString',
    'ar%00',
    'a'.repeat(100),
    'ar;q=1',
  ])('ignores %j from query, cookie and header sources', (value) => {
    const result = i18n.negotiate({
      query: { lang: value },
      headers: {
        cookie: `nv-locale=${encodeURIComponent(value)}`,
        'accept-language': value,
      },
    });
    expect(result.locale === 'en' || result.locale === 'ar').toBe(true);
    expect(i18n.locales).toContain(result.locale);
    expect(result.locale).not.toContain('<');
    expect(result.locale).not.toMatch(/[\r\n;]/);
  });
  it('ignores oversized Accept-Language and Cookie headers outright', () => {
    const bomb = 'ar,' + 'xx-YY;q=0.5,'.repeat(1000);
    expect(bomb.length).toBeGreaterThan(10_000);
    expect(
      i18n.negotiate({ headers: { 'accept-language': bomb } }).source,
    ).toBe('default');
    expect(
      i18n.negotiate({
        headers: { cookie: 'nv-locale=ar; ' + 'x=y; '.repeat(2000) },
      }).source,
    ).toBe('default');
    const spread = Array.from({ length: 40 }, () => 'de').join(',') + ',ar';
    expect(
      i18n.negotiate({ headers: { 'accept-language': spread } }).source,
    ).toBe('default');
  });
  it('does not invoke query or cookie accessors and ignores non-string values', () => {
    let reads = 0;
    const query = Object.defineProperty({}, 'lang', {
      enumerable: true,
      get() {
        reads++;
        return 'ar';
      },
    });
    expect(i18n.negotiate({ query, cookies: { 'nv-locale': 7 } }).source).toBe(
      'default',
    );
    expect(reads).toBe(0);
    const inherited = Object.create({ lang: 'ar' }) as object;
    expect(i18n.negotiate({ query: inherited }).source).toBe('default');
  });
});

describe('loadCatalogs filesystem boundaries', () => {
  it('reads only allowlisted locale directories and valid namespace files', async () => {
    const root = await temp();
    await mkdir(join(root, 'en'));
    await mkdir(join(root, 'ar'));
    await mkdir(join(root, 'de'));
    await writeFile(join(root, 'en', 'common.json'), '{"hi":"Hello"}');
    await writeFile(join(root, 'en', 'bad name.json'), '{"hi":"x"}');
    await writeFile(join(root, 'ar', 'common.json'), '{"hi":"مرحبا"}');
    await writeFile(join(root, 'de', 'common.json'), '{"hi":"Hallo"}');
    const catalogs = await loadCatalogs(root, { locales: ['en', 'ar'] });
    expect(Object.keys(catalogs).sort()).toEqual(['ar', 'en']);
    expect(Object.keys(catalogs['en'] ?? {})).toEqual(['common']);
    const i18n = new I18n({ ...base, catalogs });
    expect(i18n.t('ar', 'hi')).toBe('مرحبا');
  });
  it('rejects traversal-shaped locale or namespace names before touching the filesystem', async () => {
    const root = await temp();
    await expect(loadCatalogs(root, { locales: ['../en'] })).rejects.toThrow(
      I18nError,
    );
    await expect(
      loadCatalogs(root, { locales: ['en'], namespaces: ['../secret'] }),
    ).rejects.toThrow(I18nError);
    await expect(
      loadCatalogs(root, { locales: ['en'], namespaces: ['__proto__'] }),
    ).rejects.toThrow(I18nError);
  });
  it('rejects JSON prototype keys, oversized files and invalid JSON', async () => {
    const root = await temp();
    await mkdir(join(root, 'en'));
    await writeFile(
      join(root, 'en', 'common.json'),
      '{"__proto__":{"polluted":"yes"}}',
    );
    await expect(loadCatalogs(root, { locales: ['en'] })).rejects.toThrowError(
      expect.objectContaining({ code: 'CATALOG' }),
    );
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
    await writeFile(
      join(root, 'en', 'common.json'),
      '{"a":"' + 'x'.repeat(200) + '"}',
    );
    await expect(
      loadCatalogs(root, { locales: ['en'], maxBytes: 100 }),
    ).rejects.toThrow(/too large/);
    await writeFile(join(root, 'en', 'common.json'), '{nope');
    await expect(loadCatalogs(root, { locales: ['en'] })).rejects.toThrow(
      /valid JSON/,
    );
  });
  it('rejects catalog links that escape the directory', async () => {
    const root = await temp();
    const outside = await temp();
    await writeFile(join(outside, 'common.json'), '{"a":"secret"}');
    // A junction needs no privilege on Windows; POSIX ignores the type and links.
    await symlink(outside, join(root, 'en'), 'junction');
    await expect(loadCatalogs(root, { locales: ['en'] })).rejects.toThrowError(
      expect.objectContaining({ code: 'CATALOG' }),
    );
  });
});
