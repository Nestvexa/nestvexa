import { describe, expect, it } from 'vitest';
import { I18n, I18nError } from '../packages/i18n/dist/index.js';
import {
  createClientI18n,
  parseLocaleHydration,
  readLocaleHydration,
} from '../packages/i18n/dist/client.js';

const i18n = new I18n({
  locales: ['en', { code: 'ar', dir: 'rtl' }],
  defaultLocale: 'en',
  timeZone: 'UTC',
  catalogs: {
    en: {
      common: {
        save: 'Save',
        items: '{count, plural, one {# item} other {# items}}',
        greeting: 'Hello {name}',
      },
      products: { title: 'Products', empty: 'No products' },
      admin: { secret: 'Server-only text' },
    },
    ar: {
      common: {
        save: 'حفظ',
        items:
          '{count, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}',
        greeting: 'مرحبا {name}',
      },
      products: { title: 'المنتجات' },
    },
  },
});

describe('server hydration subset', () => {
  it('publishes only the selected namespaces and keys, resolved through fallbacks', () => {
    const payload = i18n.hydration('ar', {
      namespaces: ['products'],
      keys: ['common:items', 'common:greeting'],
    });
    expect(payload).toMatchObject({
      locale: 'ar',
      lang: 'ar',
      dir: 'rtl',
      timeZone: 'UTC',
      defaultNamespace: 'common',
    });
    expect(Object.keys(payload.messages)).toEqual([
      'common:greeting',
      'common:items',
      'products:empty',
      'products:title',
    ]);
    expect(payload.messages['products:title']).toBe('المنتجات');
    // Missing Arabic text falls back to English and records that locale.
    expect(payload.messages['products:empty']).toBe('No products');
    expect(payload.messageLocales).toEqual({ 'products:empty': 'en' });
    expect(JSON.stringify(payload)).not.toContain('Server-only text');
    expect(Object.isFrozen(payload.messages)).toBe(true);
  });
  it('fails closed without a selection and rejects unknown locales and keys', () => {
    expect(() => i18n.hydration('en', {})).toThrow(I18nError);
    expect(() => i18n.hydration('fr-CA', { keys: ['common:save'] })).toThrow(
      I18nError,
    );
    expect(() => i18n.hydration('en', { namespaces: ['__proto__'] })).toThrow(
      I18nError,
    );
    expect(() => i18n.hydration('en', { keys: ['bad key!'] })).toThrow(
      I18nError,
    );
  });
  it('writes a script element that message text cannot break out of', () => {
    const hostile = new I18n({
      locales: ['en'],
      defaultLocale: 'en',
      timeZone: 'UTC',
      catalogs: {
        en: { common: { bad: '</script><script>alert(1)</script> &  ' } },
      },
    });
    const html = hostile.hydrationScript(
      hostile.hydration('en', { keys: ['common:bad'] }),
    ).value;
    expect(
      html.startsWith('<script type="application/json" id="nv-i18n">'),
    ).toBe(true);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain(' ');
    const json = html.slice(html.indexOf('>') + 1, html.lastIndexOf('<'));
    expect(
      (JSON.parse(json) as { messages: Record<string, string> }).messages[
        'common:bad'
      ],
    ).toBe('</script><script>alert(1)</script> &  ');
    expect(() =>
      hostile.hydrationScript(
        hostile.hydration('en', { keys: ['common:bad'] }),
        'x" onload="y',
      ),
    ).toThrow(I18nError);
  });
});

describe('client translator', () => {
  it('formats plurals and parameters exactly like the server', () => {
    const payload = i18n.hydration('ar', {
      namespaces: ['common', 'products'],
    });
    const client = createClientI18n(payload);
    expect(client.dir).toBe('rtl');
    for (const count of [0, 1, 2, 3, 11, 100])
      expect(client.t('items', { count })).toBe(
        i18n.t('ar', 'common:items', { count }),
      );
    expect(client.t('common:greeting', { name: '<b>Sara</b>' })).toBe(
      'مرحبا <b>Sara</b>',
    );
    expect(client.t('products:empty')).toBe('No products');
    expect(client.t('admin:secret')).toBe('admin:secret');
    expect(client.has('save')).toBe(true);
    expect(client.formatNumber(1234.5)).toBe(
      new Intl.NumberFormat('ar').format(1234.5),
    );
  });
  it('reads the payload from a document and rejects tampered payloads', () => {
    const script = i18n.hydrationScript(
      i18n.hydration('en', { keys: ['common:save'] }),
    ).value;
    const text = script.slice(script.indexOf('>') + 1, script.lastIndexOf('<'));
    const doc = {
      getElementById: (id: string) =>
        id === 'nv-i18n' ? { textContent: text } : null,
    };
    expect(readLocaleHydration(doc)?.messages['common:save']).toBe('Save');
    expect(readLocaleHydration(doc, 'other')).toBeUndefined();
    expect(
      readLocaleHydration({ getElementById: () => ({ textContent: '{oops' }) }),
    ).toBeUndefined();
    const valid = i18n.hydration('en', { keys: ['common:save'] });
    for (const tampered of [
      { ...valid, dir: 'sideways' },
      { ...valid, locale: 'not a locale' },
      { ...valid, timeZone: 'Mars/Olympus' },
      { ...valid, messages: { '__proto__:x': 'y' } },
      { ...valid, messages: { 'common:save': 42 } },
      { ...valid, messageLocales: { 'common:other': 'en' } },
      [],
      null,
    ])
      expect(() => parseLocaleHydration(tampered)).toThrow(I18nError);
  });
});
