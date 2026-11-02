import { describe, expect, it } from 'vitest';
import { I18n, I18nError } from '../packages/i18n/dist/index.js';
import type { I18nOptions } from '../packages/i18n/dist/index.js';

function make(extra: Partial<I18nOptions> = {}): I18n {
  return new I18n({
    locales: ['en', 'en-GB', 'ar', 'fr-CA'],
    defaultLocale: 'en',
    timeZone: 'UTC',
    catalogs: { en: { common: { hi: 'Hi' } }, ar: { common: { hi: 'أهلاً' } } },
    ...extra,
  });
}
interface FakeRequest {
  query?: unknown;
  url?: string;
  cookies?: unknown;
  headers?: Record<string, string | string[]>;
}
const request = (value: FakeRequest): FakeRequest => value;

describe('locale matching', () => {
  it('canonicalizes, matches exact then base language, and never returns unlisted locales', () => {
    const i18n = make();
    expect(i18n.locales).toEqual(['en', 'en-GB', 'ar', 'fr-CA']);
    expect(i18n.match('EN-gb')).toBe('en-GB');
    expect(i18n.match('ar-SA')).toBe('ar');
    expect(i18n.match('en-US')).toBe('en');
    expect(i18n.match('fr')).toBe('fr-CA');
    expect(i18n.match('fr-FR')).toBe('fr-CA');
    for (const value of ['de', 'zz', '', 'x', 42, null, undefined, {}, ['ar']])
      expect(i18n.match(value)).toBeUndefined();
  });
});

describe('negotiation precedence', () => {
  it('prefers query, then cookie, then Accept-Language, then the default', () => {
    const i18n = make();
    const headers = {
      cookie: 'theme=dark; nv-locale=en-GB',
      'accept-language': 'fr-CA;q=0.9, ar;q=0.8',
    };
    expect(i18n.negotiate(request({ query: { lang: 'ar' }, headers }))).toEqual(
      {
        locale: 'ar',
        source: 'query',
      },
    );
    expect(i18n.negotiate(request({ query: {}, headers }))).toEqual({
      locale: 'en-GB',
      source: 'cookie',
    });
    expect(
      i18n.negotiate(
        request({ headers: { 'accept-language': headers['accept-language'] } }),
      ),
    ).toEqual({ locale: 'fr-CA', source: 'header' });
    expect(i18n.negotiate(request({ headers: {} }))).toEqual({
      locale: 'en',
      source: 'default',
    });
  });
  it('skips an unlisted candidate and falls through to the next source', () => {
    const i18n = make();
    expect(
      i18n.negotiate(
        request({
          query: { lang: 'de' },
          headers: { cookie: 'nv-locale=ar' },
        }),
      ),
    ).toEqual({ locale: 'ar', source: 'cookie' });
    expect(
      i18n.negotiate(
        request({
          headers: {
            cookie: 'nv-locale=xx',
            'accept-language': 'de, ar;q=0.1',
          },
        }),
      ),
    ).toEqual({ locale: 'ar', source: 'header' });
  });
  it('orders Accept-Language by quality and ignores q=0, wildcards and malformed entries', () => {
    const i18n = make();
    const negotiate = (value: string) =>
      i18n.negotiate(request({ headers: { 'accept-language': value } })).locale;
    expect(negotiate('en;q=0.2, ar;q=0.9')).toBe('ar');
    expect(negotiate('ar;q=0, en-GB;q=0.1')).toBe('en-GB');
    expect(negotiate('*, ar;q=0.5')).toBe('ar');
    expect(negotiate('ar;q=abc, en-GB;q=0.4')).toBe('en-GB');
    expect(negotiate('ar;q=1.5, fr-CA')).toBe('fr-CA');
    expect(negotiate('de-DE, en-GB;q=0.5, ar;q=0.5')).toBe('en-GB');
  });
  it('reads Express/Fastify query objects or parses the raw URL; arrays and duplicates are ignored', () => {
    const i18n = make();
    expect(i18n.negotiate(request({ url: '/x?lang=ar' })).locale).toBe('ar');
    expect(i18n.negotiate(request({ url: '/x?lang=ar&lang=en' })).source).toBe(
      'default',
    );
    expect(i18n.negotiate(request({ query: { lang: ['ar'] } })).source).toBe(
      'default',
    );
    expect(
      i18n.negotiate(request({ query: { lang: { toString: () => 'ar' } } }))
        .source,
    ).toBe('default');
    expect(
      i18n.negotiate(request({ cookies: { 'nv-locale': 'ar' } })).locale,
    ).toBe('ar');
    expect(
      i18n.negotiate(
        request({ headers: { cookie: 'nv-locale=ar; nv-locale=en' } }),
      ).source,
    ).toBe('default');
  });
  it('honours custom names and disabled sources', () => {
    const i18n = make({
      negotiation: { query: 'locale', cookie: false, header: false },
    });
    expect(
      i18n.negotiate(
        request({
          query: { lang: 'ar', locale: 'en-GB' },
          headers: { cookie: 'nv-locale=ar', 'accept-language': 'ar' },
        }),
      ),
    ).toEqual({ locale: 'en-GB', source: 'query' });
    expect(
      i18n.negotiate(
        request({
          headers: { cookie: 'nv-locale=ar', 'accept-language': 'ar' },
        }),
      ).source,
    ).toBe('default');
    expect(() => i18n.localeCookie('ar')).toThrow(/disabled/);
    expect(() => make({ negotiation: { query: 'a b' } })).toThrow(I18nError);
    expect(() => make({ negotiation: { cookie: 'x;y' } })).toThrow(I18nError);
  });
  it('memoizes the per-request context and composes view data', async () => {
    const i18n = make();
    const value = request({ query: { lang: 'ar' } });
    const first = i18n.forRequest(value);
    value.query = { lang: 'en' };
    expect(i18n.forRequest(value)).toBe(first);
    expect(first.locale).toBe('ar');
    expect(i18n.forRequest(request({})).locale).toBe('en');
    expect(
      await i18n.composer()('page', request({ query: { lang: 'ar' } })),
    ).toEqual({
      i18n: { locale: 'ar', lang: 'ar', dir: 'rtl', timeZone: 'UTC' },
    });
  });
});

describe('locale cookie', () => {
  it('serializes only allowlisted locales with safe attributes', () => {
    const i18n = make();
    expect(i18n.localeCookie('ar')).toBe(
      'nv-locale=ar; Path=/; Max-Age=31536000; SameSite=Lax',
    );
    expect(
      i18n.localeCookie('en-gb', {
        secure: true,
        maxAgeSeconds: 60,
        path: '/admin',
      }),
    ).toBe('nv-locale=en-GB; Path=/admin; Max-Age=60; SameSite=Lax; Secure');
    expect(() => i18n.localeCookie('de')).toThrowError(
      expect.objectContaining({ code: 'LOCALE' }),
    );
    expect(() => i18n.localeCookie('ar', { path: '/; Domain=evil' })).toThrow(
      I18nError,
    );
    expect(() => i18n.localeCookie('ar', { maxAgeSeconds: -1 })).toThrow(
      I18nError,
    );
  });
});

describe('configuration validation', () => {
  it('rejects invalid allowlists, defaults and unknown options', () => {
    const base = {
      locales: ['en'],
      defaultLocale: 'en',
      timeZone: 'UTC',
      catalogs: {},
    };
    expect(() => new I18n({ ...base, locales: [] })).toThrow(/locales/);
    expect(() => new I18n({ ...base, locales: ['en', 'EN'] })).toThrow(
      /Duplicate/,
    );
    expect(() => new I18n({ ...base, defaultLocale: 'ar' })).toThrow(
      /defaultLocale/,
    );
    expect(() => new I18n({ ...base, locales: ['en_US'] })).toThrow(
      /locale code/,
    );
    expect(
      () => new I18n({ ...base, extra: true } as unknown as I18nOptions),
    ).toThrow(/Unknown/);
    const getter = Object.defineProperty({ ...base }, 'missing', {
      enumerable: true,
      get: () => 'key',
    });
    expect(() => new I18n(getter)).toThrow(/accessor/);
    expect(
      () =>
        new I18n({ ...base, locales: [{ code: 'en', dir: 'up' } as never] }),
    ).toThrow(/dir/);
    expect(
      () => new I18n({ ...base, catalogs: { de: { common: {} } } }),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG' }));
  });
});
