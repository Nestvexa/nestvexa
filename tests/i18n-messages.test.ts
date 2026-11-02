import { describe, expect, it, vi } from 'vitest';
import { I18n, I18nError, formatMessage } from '../packages/i18n/dist/index.js';
import type { I18nOptions } from '../packages/i18n/dist/index.js';

const catalogs = {
  en: {
    common: {
      greeting: 'Hello {name}',
      items: '{count, plural, =0 {No items} one {# item} other {# items}}',
      place: '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}',
      invite:
        '{gender, select, female {She invited you} male {He invited you} other {They invited you}}',
      nested:
        '{count, plural, one {{gender, select, female {her # file} other {their # file}}} other {{gender, select, female {her # files} other {their # files}}}}',
      quoted: "It''s '{literal}' text",
      markup: '<strong>{name}</strong> joined',
      due: 'Due {when, date, long}',
      share: '{ratio, number, percent} done',
      fallbackOnly: 'English only',
    },
    products: { title: 'Products', count: 'Total: {total}' },
  },
  ar: {
    common: {
      greeting: 'مرحبًا {name}',
      items:
        '{count, plural, zero {لا توجد عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}',
    },
    products: { title: 'المنتجات' },
  },
  'ar-EG': { common: { greeting: 'أهلاً {name}' } },
  'en-GB': { products: { title: 'Products (UK)' } },
};
function make(extra: Partial<I18nOptions> = {}): I18n {
  return new I18n({
    locales: ['en', 'en-GB', 'ar', 'ar-EG'],
    defaultLocale: 'en',
    timeZone: 'UTC',
    catalogs,
    ...extra,
  });
}

describe('ICU-style messages', () => {
  it('selects English plural forms with exact matches first', () => {
    const i18n = make();
    expect(i18n.t('en', 'items', { count: 0 })).toBe('No items');
    expect(i18n.t('en', 'items', { count: 1 })).toBe('1 item');
    expect(i18n.t('en', 'items', { count: 1234 })).toBe('1,234 items');
  });
  it('covers every Arabic plural category via Intl.PluralRules', () => {
    const i18n = make();
    const cases: [number, string][] = [
      [0, 'لا توجد عناصر'],
      [1, 'عنصر واحد'],
      [2, 'عنصران'],
      [3, '3 عناصر'],
      [10, '10 عناصر'],
      [11, '11 عنصرًا'],
      [99, '99 عنصرًا'],
      [100, '100 عنصر'],
    ];
    for (const [count, expected] of cases)
      expect(i18n.t('ar', 'items', { count })).toBe(expected);
    expect(
      new Intl.PluralRules('ar').resolvedOptions().pluralCategories,
    ).toEqual(
      expect.arrayContaining(['zero', 'one', 'two', 'few', 'many', 'other']),
    );
  });
  it('supports selectordinal, select, nested branches, number and date arguments', () => {
    const i18n = make();
    expect(
      [1, 2, 3, 4, 11, 22, 103].map((n) => i18n.t('en', 'place', { n })),
    ).toEqual(['1st', '2nd', '3rd', '4th', '11th', '22nd', '103rd']);
    expect(i18n.t('en', 'invite', { gender: 'female' })).toBe(
      'She invited you',
    );
    expect(i18n.t('en', 'invite', { gender: 'unknown' })).toBe(
      'They invited you',
    );
    expect(i18n.t('en', 'invite', { gender: 'other' })).toBe(
      'They invited you',
    );
    expect(i18n.t('en', 'nested', { count: 1, gender: 'female' })).toBe(
      'her 1 file',
    );
    expect(i18n.t('en', 'nested', { count: 5, gender: 'x' })).toBe(
      'their 5 files',
    );
    expect(i18n.t('en', 'share', { ratio: 0.25 })).toBe('25% done');
    expect(
      i18n.t('en', 'due', { when: new Date('2024-03-05T12:00:00Z') }),
    ).toBe('Due March 5, 2024');
  });
  it('handles apostrophe escaping', () => {
    expect(make().t('en', 'quoted')).toBe("It's {literal} text");
    expect(
      formatMessage('en', "'#' {n, plural, other {'#' #}}", { n: 2 }),
    ).toBe("'#' # 2");
  });
  it('keeps a missing simple argument visible and rejects missing branching arguments', () => {
    const i18n = make();
    expect(i18n.t('en', 'greeting')).toBe('Hello {name}');
    expect(i18n.t('en', 'greeting', { name: null })).toBe('Hello ');
    expect(() => i18n.t('en', 'items')).toThrowError(I18nError);
    expect(() => i18n.t('en', 'items', { count: '3' })).toThrow(/number/);
    expect(() =>
      i18n.t('en', 'greeting', { name: {} as unknown as string }),
    ).toThrow(/Unsupported/);
  });
  it('rejects malformed or unsupported syntax', () => {
    for (const message of [
      '{',
      '}',
      '{name',
      '{count, plural, one {x}}',
      '{count, plural, few {x} other {y} few {z}}',
      '{count, plural, offset:1 other {#}}',
      '{count, plural, lots {x} other {y}}',
      '{x, spellout}',
      '{__proto__}',
      '{a, number, currency}',
      '{'.repeat(9) + 'a, select, other {x}' + '}'.repeat(9),
      'x'.repeat(9000),
    ])
      expect(
        () => formatMessage('en', message, {}),
        message.slice(0, 40),
      ).toThrow(I18nError);
  });
  it('escapes interpolated values only when asked and never alters literal markup', () => {
    const attack = '<img src=x onerror=alert(1)>';
    expect(
      formatMessage('en', '<b>{v}</b>', { v: attack }, { escape: true }),
    ).toBe('<b>&lt;img src=x onerror=alert(1)&gt;</b>');
    expect(formatMessage('en', '{v}', { v: attack })).toBe(attack);
    const html = make().html('en', 'markup', { name: `"${attack}'` });
    expect(html.value).toBe(
      '<strong>&quot;&lt;img src=x onerror=alert(1)&gt;&#39;</strong> joined',
    );
  });
});

describe('catalog lookup and fallback chain', () => {
  it('walks locale -> base language -> default and keeps the message language for plurals', () => {
    const i18n = make();
    expect(i18n.t('ar-EG', 'greeting', { name: 'سارة' })).toBe('أهلاً سارة');
    expect(i18n.t('ar-EG', 'products:title')).toBe('المنتجات');
    expect(i18n.t('ar-EG', 'fallbackOnly')).toBe('English only');
    expect(i18n.t('en-GB', 'products:title')).toBe('Products (UK)');
    expect(i18n.t('en-GB', 'products:count', { total: 3 })).toBe('Total: 3');
    expect(i18n.has('ar', 'fallbackOnly')).toBe(true);
    expect(i18n.has('ar', 'nope')).toBe(false);
  });
  it('honours explicit fallback chains', () => {
    const i18n = make({ fallbacks: { 'ar-EG': ['en-GB'] } });
    expect(i18n.t('ar-EG', 'products:title')).toBe('Products (UK)');
    expect(() => make({ fallbacks: { 'ar-EG': ['fr'] } })).toThrow(
      /allowlisted/,
    );
  });
  it('returns the key and reports missing translations, or throws when configured', () => {
    const onMissing = vi.fn();
    const i18n = make({ onMissing });
    expect(i18n.t('ar', 'products:missing.key')).toBe('products:missing.key');
    expect(onMissing).toHaveBeenCalledWith('products:missing.key', 'ar');
    const strict = make({ missing: 'throw' });
    expect(() => strict.t('en', 'absent')).toThrowError(
      expect.objectContaining({ code: 'MISSING' }),
    );
  });
  it('rejects unsafe or malformed keys and unlisted locales', () => {
    const i18n = make();
    for (const key of [
      '',
      'a..b',
      '__proto__',
      'common:constructor',
      'x:y:z',
      'a'.repeat(300),
    ])
      expect(() => i18n.t('en', key), key).toThrow(I18nError);
    expect(() => i18n.t('fr', 'greeting')).toThrowError(
      expect.objectContaining({ code: 'LOCALE' }),
    );
  });
  it('exposes a frozen locale-bound context and view', () => {
    const i18n = make();
    const context = i18n.context('ar');
    expect(context).toBe(i18n.context('ar'));
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.view).toEqual({
      locale: 'ar',
      lang: 'ar',
      dir: 'rtl',
      timeZone: 'UTC',
    });
    expect(context.t('greeting', { name: 'x' })).toBe('مرحبًا x');
    expect(i18n.dir('en-GB')).toBe('ltr');
    expect(i18n.dir('ar-EG')).toBe('rtl');
  });
  it('infers direction from language and script subtags unless explicitly defined', () => {
    const i18n = new I18n({
      locales: [
        'he',
        'fa',
        'ur',
        'pa-Arab',
        'ku-Latn',
        'az-Arab',
        { code: 'ar-Latn' },
        { code: 'en', dir: 'rtl', label: 'Mirror' },
      ],
      defaultLocale: 'he',
      timeZone: 'UTC',
      catalogs: {},
    });
    expect(i18n.definitions().map(({ code, dir }) => `${code}:${dir}`)).toEqual(
      [
        'he:rtl',
        'fa:rtl',
        'ur:rtl',
        'pa-Arab:rtl',
        'ku-Latn:ltr',
        'az-Arab:rtl',
        'ar-Latn:ltr',
        'en:rtl',
      ],
    );
    expect(i18n.definitions()[0]?.label).toBe('עברית');
    expect(i18n.definitions()[7]?.label).toBe('Mirror');
  });
});

describe('Intl formatting with an explicit time-zone policy', () => {
  const instant = '2024-01-01T22:30:00Z';
  it('renders the same instant on different calendar days per policy', () => {
    const riyadh = make({ timeZone: 'Asia/Riyadh' });
    const la = make({ timeZone: 'America/Los_Angeles' });
    expect(riyadh.formatDate('en', instant, { dateStyle: 'medium' })).toBe(
      'Jan 2, 2024',
    );
    expect(la.formatDate('en', instant, { dateStyle: 'medium' })).toBe(
      'Jan 1, 2024',
    );
    expect(
      riyadh.formatDate('en', instant, {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }),
    ).toBe('Jan 1, 2024');
    expect(
      riyadh.formatDate('en', Date.parse(instant), { timeStyle: 'short' }),
    ).toBe('1:30 AM');
  });
  it('formats numbers, currency and relative time per locale', () => {
    const i18n = make();
    expect(i18n.formatNumber('en', 1234567.891)).toBe('1,234,567.891');
    expect(i18n.formatNumber('en', 0.5, { style: 'percent' })).toBe('50%');
    expect(i18n.formatCurrency('en', 12.5, 'EUR')).toBe('€12.50');
    expect(i18n.formatCurrency('ar', 12.5, 'SAR')).toContain('ر.س.');
    const now = Date.parse('2024-06-10T12:00:00Z');
    expect(i18n.formatRelative('en', now - 3 * 86_400_000, { now })).toBe(
      '3 days ago',
    );
    expect(i18n.formatRelative('en', now + 90_000, { now })).toBe(
      'in 2 minutes',
    );
    expect(i18n.formatRelative('en', now - 86_400_000, { now })).toBe(
      'yesterday',
    );
    expect(
      i18n.formatRelative('en', now - 86_400_000, { now, numeric: 'always' }),
    ).toBe('1 day ago');
    expect(
      i18n.formatRelative('en', now + 7_200_000, { now, unit: 'minute' }),
    ).toBe('in 120 minutes');
    expect(i18n.formatRelative('ar', now - 2 * 86_400_000, { now })).toBe(
      new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }).format(-2, 'day'),
    );
  });
  it('rejects invalid time zones, currencies, dates, numbers and option keys', () => {
    const i18n = make();
    expect(() => make({ timeZone: 'Mars/Olympus' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG' }),
    );
    expect(
      () =>
        new I18n({
          locales: ['en'],
          defaultLocale: 'en',
          catalogs: {},
        } as unknown as I18nOptions),
    ).toThrow(/timeZone is required/);
    expect(() =>
      i18n.formatDate('en', instant, { timeZone: 'Not/AZone' }),
    ).toThrowError(expect.objectContaining({ code: 'FORMAT' }));
    for (const currency of ['eur', 'EURO', 'E<R', ''])
      expect(() => i18n.formatCurrency('en', 1, currency)).toThrow(I18nError);
    for (const value of ['yesterday', '2024-13-45', 'Jan 1 2024', NaN])
      expect(() => i18n.formatDate('en', value)).toThrow(I18nError);
    expect(() => i18n.formatNumber('en', Infinity)).toThrow(I18nError);
    expect(() =>
      i18n.formatNumber('en', 1, {
        localeMatcher: 'lookup',
      } as Intl.NumberFormatOptions),
    ).toThrow(/Unsupported/);
    expect(() =>
      i18n.formatDate('en', instant, {
        dateStyle: 'gigantic',
      } as unknown as Intl.DateTimeFormatOptions),
    ).toThrowError(expect.objectContaining({ code: 'FORMAT' }));
    expect(() =>
      i18n.formatRelative('en', instant, {
        unit: 'fortnight' as Intl.RelativeTimeFormatUnit,
      }),
    ).toThrow(I18nError);
  });
});
