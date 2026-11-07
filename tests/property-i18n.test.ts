import fc from 'fast-check';
import { propertyRuns } from './support/property-runs.js';
import { describe, expect, it } from 'vitest';
import { I18nError } from '../packages/i18n/src/errors.js';
import { canonicalLocale } from '../packages/i18n/src/locale.js';
import {
  formatMessage,
  maxMessageLength,
  parseMessage,
} from '../packages/i18n/src/message.js';
import {
  acceptLanguages,
  cookieValue,
} from '../packages/i18n/src/negotiation.js';

/**
 * Property-based checks for the ICU MessageFormat subset and locale
 * negotiation. Catalog text is trusted but large and translator-edited;
 * parameters, Accept-Language and cookies are attacker-controlled.
 */
const runs = propertyRuns(400);
const forbidden = ['__proto__', 'constructor', 'prototype'];
const name = fc
  .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/)
  .filter((value) => !forbidden.includes(value));
const plainText = fc.string({ unit: 'binary', maxLength: 40 }).map((text) =>
  // Characters with ICU meaning in the subset; everything else is literal.
  text.replace(/[{}'#]/g, ''),
);
/** ICU quoting of arbitrary literal text, the way a catalog tool would emit it. */
function quote(text: string): string {
  return text.replace(/'/g, "''").replace(/[{}#]+/g, (run) => `'${run}'`);
}

function i18nCode(operation: () => unknown): string {
  try {
    operation();
    return 'ok';
  } catch (error) {
    if (!(error instanceof I18nError)) throw error;
    return error.code;
  }
}

describe('message parser properties', () => {
  it('throws only I18nError for arbitrary catalog text and terminates', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc
            .array(
              fc.constantFrom(
                '{',
                '}',
                "'",
                '#',
                ',',
                'n',
                'plural',
                'select',
                'selectordinal',
                'number',
                'date',
                'other',
                'one',
                '=1',
                ' ',
                '__proto__',
                ':',
                'offset:1',
              ),
              { maxLength: 60 },
            )
            .map((parts) => parts.join('')),
        ),
        (source) => {
          expect(['ok', 'MESSAGE']).toContain(
            i18nCode(() => parseMessage(source)),
          );
        },
      ),
      runs,
    );
  });

  it('rejects oversized messages and nesting beyond the depth limit', () => {
    expect(i18nCode(() => parseMessage('x'.repeat(maxMessageLength + 1)))).toBe(
      'MESSAGE',
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (depth) => {
        let source = 'leaf';
        for (let level = 0; level < depth; level++)
          source = `{v, select, other {${source}}}`;
        expect(i18nCode(() => parseMessage(source))).toBe(
          depth <= 8 ? 'ok' : 'MESSAGE',
        );
      }),
      propertyRuns(40),
    );
  });

  it('renders quoted literal text exactly', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (text) => {
        fc.pre(!/[\ud800-\udfff]/.test(text));
        const source = quote(text);
        fc.pre(source.length <= maxMessageLength);
        expect(formatMessage('en', source)).toBe(text);
      }),
      runs,
    );
  });
});

describe('message rendering properties', () => {
  it('escapes every interpolated value when escaping is enabled', () => {
    fc.assert(
      fc.property(
        name,
        fc.string({ unit: 'binary', maxLength: 40 }),
        plainText,
        (key, value, prefix) => {
          const output = formatMessage(
            'en',
            `${prefix}{${key}}`,
            { [key]: value },
            { escape: true },
          );
          const interpolated = output.slice(prefix.length);
          expect(interpolated).not.toMatch(/[<>"'`]/);
          expect(
            interpolated
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&#96;/g, '`')
              .replace(/&amp;/g, '&'),
          ).toBe(value);
          // Literal (trusted) catalog text is never altered by escaping.
          expect(output.startsWith(prefix)).toBe(true);
        },
      ),
      runs,
    );
  });

  it('selects branches by value without consulting prototype members', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            ...forbidden,
            'toString',
            'hasOwnProperty',
            'valueOf',
          ),
          fc.string({ maxLength: 10 }),
        ),
        (choice) => {
          const output = formatMessage(
            'en',
            '{choice, select, admin {A} other {O}}',
            { choice },
          );
          expect(output).toBe(choice === 'admin' ? 'A' : 'O');
        },
      ),
      runs,
    );
  });

  it('chooses exact plural matches before categories for any finite number', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1000, max: 1000 }),
          fc.double({
            noNaN: true,
            noDefaultInfinity: true,
            min: -1e6,
            max: 1e6,
          }),
        ),
        fc.constantFrom('en', 'ar', 'fr', 'ru', 'ja'),
        (count, locale) => {
          const output = formatMessage(
            locale,
            '{count, plural, =0 {none} =1 {single} other {many #}}',
            { count },
          );
          if (count === 0) expect(output).toBe('none');
          else if (count === 1) expect(output).toBe('single');
          else expect(output.startsWith('many ')).toBe(true);
        },
      ),
      runs,
    );
  });

  it('rejects non-primitive and accessor parameters without invoking them', () => {
    let invoked = false;
    const params = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        invoked = true;
        return 'x';
      },
    });
    expect(formatMessage('en', 'Hi {name}', params)).toBe('Hi {name}');
    expect(invoked).toBe(false);
    fc.assert(
      fc.property(
        fc.oneof(
          fc.object(),
          fc.array(fc.anything()),
          fc.bigInt(),
          fc.constant(Symbol('s')),
        ),
        (value) => {
          expect(
            i18nCode(() =>
              formatMessage('en', 'Hi {name}', {
                name: value,
              } as unknown as Record<string, string>),
            ),
          ).toBe('MESSAGE');
        },
      ),
      propertyRuns(100),
    );
  });
});

describe('locale negotiation properties', () => {
  it('canonicalizes only bounded BCP 47 tags and never throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ unit: 'binary', maxLength: 50 }), fc.anything()),
        (value) => {
          const canonical = canonicalLocale(value);
          if (canonical !== undefined) {
            expect(canonical.length).toBeLessThanOrEqual(35);
            expect(Intl.getCanonicalLocales(canonical)).toEqual([canonical]);
          }
        },
      ),
      runs,
    );
  });

  it('parses any Accept-Language header into a bounded, quality-ordered list', () => {
    const range = fc.tuple(
      fc.oneof(
        fc.stringMatching(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
        fc.constantFrom('*', '', '__proto__'),
      ),
      fc.option(
        fc.oneof(
          fc.constantFrom(
            '0',
            '1',
            '0.5',
            '1.000',
            '0.999',
            '2',
            '-1',
            'NaN',
            '0.0001',
            '',
          ),
          fc.string({ maxLength: 5 }),
        ),
      ),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .array(range, { maxLength: 40 })
            .map((ranges) =>
              ranges
                .map(([tag, q]) => (q === null ? tag : `${tag};q=${q}`))
                .join(','),
            ),
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc.constant('en,'.repeat(3000)),
        ),
        (header) => {
          const tags = acceptLanguages({
            headers: { 'accept-language': header },
          });
          expect(tags.length).toBeLessThanOrEqual(32);
          for (const tag of tags) {
            expect(tag).not.toBe('*');
            expect(tag.trim()).toBe(tag);
            expect(tag.length).toBeGreaterThan(0);
          }
        },
      ),
      runs,
    );
  });

  it('reads one unambiguous cookie value and ignores duplicates or bad encodings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('nv_locale', 'other', ' nv_locale'),
            fc.string({ unit: 'binary', maxLength: 12 }),
          ),
          { maxLength: 6 },
        ),
        (pairs) => {
          const header = pairs
            .map(([key, value]) => `${key}=${value}`)
            .join(';');
          const value = cookieValue(
            { headers: { cookie: header } },
            'nv_locale',
          );
          const matches = pairs.filter(([key]) => key.trim() === 'nv_locale');
          if (matches.length !== 1 || header.length > 4096) {
            if (matches.length > 1) expect(value).toBeUndefined();
          }
          if (value !== undefined) expect(typeof value).toBe('string');
        },
      ),
      runs,
    );
  });
});
