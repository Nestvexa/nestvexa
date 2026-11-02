import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  extractFromDirectory,
  extractKeys,
  missingKeys,
  serializeKeys,
} from '../packages/i18n/dist/extract.js';

const hbs = {
  file: 'views/products.hbs',
  content: [
    '<h1>{{t "products:title"}}</h1>',
    "<p>{{tHtml 'welcome' name=user}}</p>",
    '{{#if (t "products:empty")}}x{{/if}}',
    '{{~ t "products:count" count=n}}',
    '<p>{{t dynamicKey}}</p>',
    '<p>{{t "bad key!"}}</p>',
    '<p>{{title}} {{tooltip "no"}}</p>',
  ].join('\n'),
};
const ts = {
  file: 'src\\products.ts',
  content: [
    "const a = i18n.t(locale, 'products:saved');",
    'const b = context.t("validation.required");',
    "const c = t('common:ok');",
    "const d = this.i18n.t('ar', 'products:arabic');",
    'const e = i18n.html(this.locale, `products:rich`);',
    'const f = t(`products:${kind}`);',
    'const g = t(keyVariable);',
    'function t(key: string) { return key; }',
    'class X { t(locale: string, key: string) {} }',
    "const h = format('not:extracted');",
  ].join('\n'),
};

describe('translation key extraction', () => {
  it('extracts literal keys from .hbs and .ts and reports dynamic or invalid ones', () => {
    const result = extractKeys([hbs, ts]);
    expect(result.keys).toEqual({
      common: ['ok', 'validation.required', 'welcome'],
      products: ['arabic', 'count', 'empty', 'rich', 'saved', 'title'],
    });
    expect(result.dynamic).toEqual([
      { file: 'src/products.ts', line: 6, reason: 'dynamic' },
      { file: 'src/products.ts', line: 7, reason: 'dynamic' },
      { file: 'views/products.hbs', line: 5, reason: 'dynamic' },
      { file: 'views/products.hbs', line: 6, reason: 'invalid' },
    ]);
  });
  it('is deterministic across runs and input orders', () => {
    const first = serializeKeys(extractKeys([hbs, ts]));
    const second = serializeKeys(extractKeys([ts, hbs]));
    expect(second).toBe(first);
    expect(serializeKeys(extractKeys([hbs, ts]))).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  it('supports a custom default namespace and function names', () => {
    const result = extractKeys(
      [{ file: 'a.ts', content: "translate('x'); t('y')" }],
      { defaultNamespace: 'admin', functions: ['translate'] },
    );
    expect(result.keys).toEqual({ admin: ['x'] });
    expect(() => extractKeys([], { functions: ['a b'] })).toThrow();
    expect(() => extractKeys([], { defaultNamespace: '__proto__' })).toThrow();
  });
  it('lists keys missing per locale without applying fallbacks', () => {
    const extracted = extractKeys([hbs, ts]);
    const missing = missingKeys(
      extracted,
      {
        en: {
          common: { ok: 'OK', welcome: 'Hi', validation: { required: 'Req' } },
          products: {
            title: 'P',
            count: 'C',
            empty: 'E',
            rich: 'R',
            saved: 'S',
            arabic: 'A',
          },
        },
        ar: { common: { ok: 'حسنًا' } },
      },
      ['en', 'ar', 'fr'],
    );
    expect(missing['en']).toEqual([]);
    expect(missing['ar']).toEqual([
      'common:validation.required',
      'common:welcome',
      'products:arabic',
      'products:count',
      'products:empty',
      'products:rich',
      'products:saved',
      'products:title',
    ]);
    expect(missing['fr']?.length).toBe(9);
    expect(Object.keys(missing)).toEqual(['ar', 'en', 'fr']);
  });
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nv-i18n-extract-'));
  directories.push(root);
  await mkdir(join(root, 'src', 'views'), { recursive: true });
  await mkdir(join(root, 'src', 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(root, 'src', 'dist'), { recursive: true });
  await mkdir(join(root, 'locales', 'en'), { recursive: true });
  await mkdir(join(root, 'locales', 'ar'), { recursive: true });
  await writeFile(join(root, 'src', 'views', 'b.hbs'), '{{t "title"}}');
  await writeFile(
    join(root, 'src', 'a.ts'),
    "i18n.t(locale, 'products:saved');",
  );
  await writeFile(join(root, 'src', 'types.d.ts'), "t('ignored');");
  await writeFile(
    join(root, 'src', 'node_modules', 'dep', 'x.ts'),
    "t('ignored');",
  );
  await writeFile(join(root, 'src', 'dist', 'y.ts'), "t('ignored');");
  await writeFile(
    join(root, 'locales', 'en', 'common.json'),
    JSON.stringify({ title: 'Title' }),
  );
  await writeFile(
    join(root, 'locales', 'en', 'products.json'),
    JSON.stringify({ saved: 'Saved' }),
  );
  await writeFile(
    join(root, 'locales', 'ar', 'common.json'),
    JSON.stringify({ title: 'العنوان' }),
  );
  return root;
}
const cli = resolve('packages/i18n/dist/extract-cli.js');

// Each CLI case spawns a real Node process; allow for loaded CI hosts.
describe('directory extraction and CLI', () => {
  it('walks sorted sources and skips node_modules, dist and declaration files', async () => {
    const root = await fixture();
    const result = await extractFromDirectory(join(root, 'src'));
    expect(result.keys).toEqual({ common: ['title'], products: ['saved'] });
    expect(serializeKeys(await extractFromDirectory(join(root, 'src')))).toBe(
      serializeKeys(result),
    );
  });
  it('writes deterministic JSON and exits 1 when catalogs miss keys', async () => {
    const root = await fixture();
    const out = join(root, 'keys.json');
    const ok = spawnSync(
      process.execPath,
      [cli, join(root, 'src'), '--out', out],
      {
        encoding: 'utf8',
      },
    );
    expect(ok.status).toBe(0);
    const written = await readFile(out, 'utf8');
    expect(JSON.parse(written)).toEqual({
      keys: { common: ['title'], products: ['saved'] },
      dynamic: [],
    });
    const again = spawnSync(process.execPath, [cli, join(root, 'src')], {
      encoding: 'utf8',
    });
    expect(again.stdout).toBe(written);
    const check = spawnSync(
      process.execPath,
      [
        cli,
        join(root, 'src'),
        '--catalogs',
        join(root, 'locales'),
        '--locales',
        'en,ar',
      ],
      { encoding: 'utf8' },
    );
    expect(check.status).toBe(1);
    expect(JSON.parse(check.stdout).missing).toEqual({
      ar: ['products:saved'],
      en: [],
    });
    expect(check.stderr).toContain('1 translation(s) missing');
    await writeFile(
      join(root, 'locales', 'ar', 'products.json'),
      JSON.stringify({ saved: 'تم الحفظ' }),
    );
    const complete = spawnSync(
      process.execPath,
      [
        cli,
        join(root, 'src'),
        '--catalogs',
        join(root, 'locales'),
        '--locales',
        'en,ar',
      ],
      { encoding: 'utf8' },
    );
    expect(complete.status).toBe(0);
  }, 60_000);
  it('rejects invalid arguments with exit code 2', () => {
    for (const args of [
      [],
      ['a', 'b'],
      ['a', '--catalogs', 'x'],
      ['a', '--unknown', 'x'],
      ['a', '--catalogs', 'x', '--locales', '../en'],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
      });
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('Usage');
    }
  }, 60_000);
});
