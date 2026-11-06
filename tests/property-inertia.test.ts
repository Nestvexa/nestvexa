import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  InertiaRedirectError,
  InertiaRequestError,
} from '../packages/inertia/src/errors.js';
import {
  assertSafeRedirect,
  refererPath,
  relativeRequestUrl,
} from '../packages/inertia/src/redirect.js';
import {
  defaultHeaderLimits,
  parseInertiaRequest,
} from '../packages/inertia/src/request.js';
import { escapeJsonForScript } from '../packages/inertia/src/serialize.js';
import { isSafeRedirect } from '../packages/actions/src/shared/protocol.js';
import { safeRedirectPath } from '../packages/live/src/effects.js';

/**
 * Property-based checks for Inertia request headers, every redirect target
 * validator in the workspace, and script-embedded page JSON.
 */
const runs = { numRuns: 400 };
const forbidden = ['__proto__', 'prototype', 'constructor'];
const origin = 'https://app.example';
const policy = { allowedOrigins: new Set(['https://cdn.example']) };
const listHeaders = [
  'x-inertia-partial-data',
  'x-inertia-partial-except',
  'x-inertia-reset',
  'x-inertia-except-once-props',
] as const;
const headerValue = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc
    .tuple(
      fc.array(
        fc.oneof(
          fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/),
          fc.constantFrom(...forbidden, '', '.', '..', 'a.', '.a', ',', '\r\n'),
        ),
        { maxLength: 8 },
      ),
      fc.constantFrom(',', '.'),
    )
    .map(([parts, separator]) => parts.join(separator)),
  fc.array(fc.string({ maxLength: 4 }), { minLength: 1, maxLength: 3 }),
  fc.anything(),
  fc.constant('x'.repeat(5000)),
);
function hostileUrl() {
  return fc.oneof(
    fc.string({ unit: 'binary', maxLength: 60 }),
    fc
      .array(
        fc.oneof(
          fc.constantFrom(
            '/',
            '\\',
            '//',
            '/\\',
            '\\/',
            'evil.example',
            'javascript:',
            'data:',
            'https:',
            'http://',
            'https://cdn.example',
            'https://user:pw@cdn.example',
            '@',
            '%2f',
            '%5c',
            '\t',
            '\n',
            ' ',
            '。',
            '／',
            '?',
            '#',
            '..',
            '日本',
          ),
          fc.stringMatching(/^[a-z0-9]{1,5}$/),
        ),
        { minLength: 1, maxLength: 7 },
      )
      .map((parts) => parts.join('')),
  );
}
/** What the official Inertia client and every browser do with a Location value. */
function resolvedOrigin(target: string): string {
  return new URL(target, `${origin}/current/page`).origin;
}
function headerSafe(value: string): boolean {
  // Node's validateHeaderValue: no CR/LF/NUL and nothing above Latin-1.
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

describe('Inertia request header properties', () => {
  it('never rejects or interprets Inertia headers on plain (non-Inertia) requests', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            ...listHeaders,
            'x-inertia-version',
            'x-inertia-error-bag',
          ),
          headerValue,
        ),
        (headers) => {
          const info = parseInertiaRequest({ headers });
          expect(info.inertia).toBe(false);
          expect(info.only).toBeUndefined();
          expect(info.except).toBeUndefined();
          expect(info.reset).toEqual([]);
        },
      ),
      runs,
    );
  });

  it('either rejects with a 400 or returns bounded, prototype-safe prop paths', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            ...listHeaders,
            'x-inertia-version',
            'x-inertia-error-bag',
            'x-inertia-partial-component',
            'x-inertia-infinite-scroll-merge-intent',
            'purpose',
            'sec-purpose',
          ),
          headerValue,
        ),
        fc.constantFrom('true', 'TRUE', 'True'),
        (headers, flag) => {
          let info;
          try {
            info = parseInertiaRequest({
              method: 'GET',
              headers: { ...headers, 'x-inertia': flag },
            });
          } catch (error) {
            expect(error).toBeInstanceOf(InertiaRequestError);
            expect((error as InertiaRequestError).getStatus()).toBe(400);
            return;
          }
          expect(info.inertia).toBe(true);
          for (const list of [
            info.only,
            info.except,
            info.reset,
            info.exceptOnce,
          ])
            for (const entry of list ?? []) {
              expect(entry.length).toBeLessThanOrEqual(
                defaultHeaderLimits.entryLength,
              );
              for (const segment of entry.split('.')) {
                expect(segment).not.toBe('');
                expect(forbidden).not.toContain(segment);
              }
              expect(entry).not.toMatch(/\p{Cc}/u);
            }
          expect(['append', 'prepend']).toContain(info.mergeIntent);
          if (info.errorBag !== undefined) {
            expect(forbidden).not.toContain(info.errorBag);
            expect(info.errorBag).not.toContain('.');
          }
          for (const value of [
            info.version,
            info.partialComponent,
            info.errorBag,
          ])
            if (value !== undefined) expect(value).not.toMatch(/\p{Cc}/u);
        },
      ),
      runs,
    );
  });

  it('round-trips valid comma-separated prop paths in order', () => {
    const path = fc
      .array(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,10}$/), {
        minLength: 1,
        maxLength: 4,
      })
      .map((segments) => segments.join('.'));
    fc.assert(
      fc.property(fc.array(path, { minLength: 1, maxLength: 20 }), (paths) => {
        fc.pre(
          !paths.some((entry) =>
            entry.split('.').some((segment) => forbidden.includes(segment)),
          ),
        );
        const info = parseInertiaRequest({
          headers: {
            'x-inertia': 'true',
            'x-inertia-partial-data': paths.join(','),
          },
        });
        expect(info.only).toEqual(paths);
      }),
      runs,
    );
  });

  it('treats repeated (array) headers as malformed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...listHeaders,
          'x-inertia-version',
          'x-inertia-error-bag',
        ),
        fc.array(fc.stringMatching(/^[a-z]{1,5}$/), {
          minLength: 2,
          maxLength: 3,
        }),
        (name, values) => {
          expect(() =>
            parseInertiaRequest({
              headers: { 'x-inertia': 'true', [name]: values },
            }),
          ).toThrow(InertiaRequestError);
        },
      ),
      runs,
    );
  });
});

describe('redirect target properties (Inertia, Live, server actions)', () => {
  it('Inertia accepts only same-origin or allowlisted, header-safe targets', () => {
    fc.assert(
      fc.property(hostileUrl(), (target) => {
        let accepted: string;
        try {
          accepted = assertSafeRedirect(target, policy);
        } catch (error) {
          expect(error).toBeInstanceOf(InertiaRedirectError);
          return;
        }
        expect([origin, 'https://cdn.example']).toContain(
          resolvedOrigin(accepted),
        );
        expect(headerSafe(accepted)).toBe(true);
        expect(accepted).not.toMatch(/[\\\p{Cc}]/u);
      }),
      runs,
    );
  });

  it('Inertia keeps ASCII targets byte-for-byte and percent-encodes others', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\/[A-Za-z0-9/_.~?=&-]{0,40}$/),
        fc
          .string({ unit: 'grapheme', minLength: 1, maxLength: 6 })
          .filter((text) => /^[^\p{ASCII}]+$/u.test(text)),
        (path, unicode) => {
          fc.pre(!path.startsWith('//'));
          expect(assertSafeRedirect(path, policy)).toBe(path);
          const target = `${path}${unicode}`;
          let accepted: string | undefined;
          try {
            accepted = assertSafeRedirect(target, policy);
          } catch {
            accepted = undefined;
          }
          if (accepted !== undefined) {
            expect(headerSafe(accepted)).toBe(true);
            expect(decodeURIComponent(accepted.slice(path.length))).toBe(
              target.slice(path.length),
            );
          }
        },
      ),
      runs,
    );
  });

  it('Live and server-action validators never yield off-site targets', () => {
    fc.assert(
      fc.property(hostileUrl(), (target) => {
        if (isSafeRedirect(target)) expect(resolvedOrigin(target)).toBe(origin);
        let live: string | undefined;
        try {
          live = safeRedirectPath(target);
        } catch {
          live = undefined;
        }
        if (live !== undefined) {
          expect(resolvedOrigin(live)).toBe(origin);
          expect(headerSafe(live)).toBe(true);
        }
      }),
      runs,
    );
  });

  it('referer-based back() targets stay on the request host or allowlist', () => {
    fc.assert(
      fc.property(
        hostileUrl(),
        fc.constantFrom('app.example', 'APP.example', undefined),
        (referer, host) => {
          const path = refererPath(referer, host, policy);
          if (path === undefined) return;
          expect([origin, 'https://cdn.example']).toContain(
            resolvedOrigin(path),
          );
        },
      ),
      runs,
    );
  });

  it('relative request URLs used in X-Inertia-Location can never leave the origin', () => {
    fc.assert(
      fc.property(hostileUrl(), (raw) => {
        const location = relativeRequestUrl(raw);
        expect(location.startsWith('/')).toBe(true);
        expect(resolvedOrigin(location)).toBe(origin);
        expect(location).not.toContain('\\');
        // C0/DEL are encoded; C1 code units may be Latin-1-decoded UTF-8 bytes.
        expect(
          [...location].some((character) => {
            const code = character.charCodeAt(0);
            return code < 0x20 || code === 0x7f;
          }),
        ).toBe(false);
        expect(headerSafe(location) || /[^\p{ASCII}]/u.test(raw)).toBe(true);
      }),
      runs,
    );
  });

  it('regression: a backslash request path cannot become a scheme-relative location', () => {
    // `new URL('/\\evil.example', base)` resolves to https://evil.example/.
    expect(new URL('/\\evil.example', origin).origin).toBe(
      'https://evil.example',
    );
    expect(relativeRequestUrl('/\\evil.example/x')).toBe('/%5Cevil.example/x');
    expect(relativeRequestUrl('\\\\evil.example')).toBe('/%5C%5Cevil.example');
    expect(relativeRequestUrl('//\\evil.example')).toBe('/%5Cevil.example');
    expect(relativeRequestUrl('/lazy?x=1')).toBe('/lazy?x=1');
  });

  it('regression: non-ASCII redirect targets are encoded instead of crashing the reply', () => {
    expect(assertSafeRedirect('/products/日本', policy)).toBe(
      '/products/%E6%97%A5%E6%9C%AC',
    );
    expect(() => assertSafeRedirect('/bad\ud800', policy)).toThrow(
      InertiaRedirectError,
    );
    expect(assertSafeRedirect('https://cdn.example/ü', policy)).toBe(
      'https://cdn.example/%C3%BC',
    );
  });
});

describe('script-embedded page JSON properties', () => {
  it('never contains script-closing or line-separator characters and parses back losslessly', () => {
    fc.assert(
      fc.property(
        fc.jsonValue({ maxDepth: 4, stringUnit: 'binary' }),
        (value) => {
          const embedded = escapeJsonForScript(JSON.stringify(value));
          expect(embedded).not.toMatch(/[<>&\u2028\u2029]/);
          expect(embedded).not.toMatch(/(?<!\\)\//);
          expect(JSON.stringify(JSON.parse(embedded))).toBe(
            JSON.stringify(value),
          );
        },
      ),
      runs,
    );
  });
});
