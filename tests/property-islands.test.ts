import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { build } from 'esbuild';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IslandError,
  IslandRegistry,
  checkIslandProps,
  parseIslandManifest,
  parseSharedContext,
  serializeProps,
} from '../packages/islands/dist/index.js';
import { propertyRuns } from './support/property-runs.js';

/**
 * Property-based fuzzing of islands hydration (SEC-004): the props the
 * server serializes into `data-nv-props`, the signed-props tokens an island
 * sends back, the manifest and shared-context parsers, and the browser
 * loader reading hostile hydration attributes in real Chromium. Invariants:
 * nothing crashes with anything but the package's own errors, prototypes are
 * never polluted, markup cannot be injected or executed, and hostile input is
 * rejected or reaches the island as inert data.
 */
const runs = propertyRuns(200);
const browserRuns = propertyRuns(60);
const keyA = 'islands-property-key-a-0123456789abcdef';
const keyB = 'islands-property-key-b-0123456789abcdef';

/** Strings that break out of attributes, scripts or JSON when mishandled. */
const hostile = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom(
    '"><img src=x onerror="window.__pwned=1">',
    "'><svg onload=window.__pwned=1>",
    '</script><script>window.__pwned=1</script>',
    '<!--',
    '&quot;&#39;&lt;',
    '  ',
    '${window.__pwned=1}',
    '{{constructor.constructor("window.__pwned=1")()}}',
    'javascript:window.__pwned=1',
  ),
);
const forbiddenKeys = ['__proto__', 'constructor', 'prototype'] as const;
const propKey = fc.oneof(
  fc.stringMatching(/^[a-z][A-Za-z0-9]{0,8}$/),
  fc.constantFrom(...forbiddenKeys, 'password', 'apiKey', 'onerror', 'x"y'),
);
const jsonProps = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    hostile,
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    tie('object'),
  ),
  object: fc
    .array(fc.tuple(propKey, tie('value')), { maxLength: 5 })
    .map((entries) => {
      // Own properties even for `__proto__`, as JSON.parse would create them.
      const object: Record<string, unknown> = {};
      for (const [key, value] of entries)
        Object.defineProperty(object, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return object;
    }),
})).object;

function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 40 || typeof value !== 'object' || value === null) return false;
  return Object.keys(value).some(
    (key) =>
      (forbiddenKeys as readonly string[]).includes(key) ||
      hasForbiddenKey(Reflect.get(value, key), depth + 1),
  );
}
function hasSensitiveKey(value: unknown, depth = 0): boolean {
  if (depth > 40 || typeof value !== 'object' || value === null) return false;
  return Object.keys(value).some(
    (key) =>
      (!Array.isArray(value) &&
        /password|passwd|^pass$|secret|token|api[-_]?key|credential|session|cookie|authorization|csrf|private[-_]?key/i.test(
          key,
        )) ||
      hasSensitiveKey(Reflect.get(value, key), depth + 1),
  );
}
const unescape = (value: string) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
const polluted = () =>
  Reflect.get(Object.prototype, 'polluted') !== undefined ||
  Reflect.get(Object.prototype, 'isAdmin') !== undefined;

function registry(now = () => Date.now()) {
  return new IslandRegistry(
    [
      { id: 'probe', framework: 'custom', strategy: 'immediate' },
      { id: 'signed', framework: 'custom', signed: true },
      { id: 'other', framework: 'custom', signed: true },
    ],
    { signingKeys: [keyA], now },
  );
}

describe('island props serialization (server)', () => {
  it('rejects unsafe or secret-like keys and renders anything else as inert, round-tripping data', () => {
    const islands = registry();
    fc.assert(
      fc.property(jsonProps, (props) => {
        let html: string;
        try {
          html = islands.render('probe', props).value;
        } catch (error) {
          // Only the package's own refusals, and only for a reason.
          expect(error).toBeInstanceOf(IslandError);
          expect(hasForbiddenKey(props) || hasSensitiveKey(props)).toBe(true);
          return;
        }
        expect(hasForbiddenKey(props)).toBe(false);
        // One element start tag with quoted attributes: no `<`, `>` or
        // unescaped quote inside, so no attribute or tag can be injected.
        const match = /^<div ([^<>]*)>(.*)<\/div>$/s.exec(html);
        expect(match).not.toBeNull();
        const attributes = match?.[1] ?? '';
        expect(attributes).toMatch(/^(?:[a-z-]+="[^"]*"\s?)+$/);
        // Hostile text stays inside quoted values: no event-handler names.
        const names = [...attributes.matchAll(/([a-z-]+)="[^"]*"/g)].map(
          (found) => found[1],
        );
        expect(names.filter((name) => name?.startsWith('on'))).toEqual([]);
        const raw = /data-nv-props="([^"]*)"/.exec(attributes)?.[1] ?? '';
        expect(JSON.parse(unescape(raw))).toEqual(
          JSON.parse(JSON.stringify(props)),
        );
        expect(polluted()).toBe(false);
      }),
      runs,
    );
  });

  it('accepts only JSON data: anything else throws IslandError', () => {
    fc.assert(
      fc.property(fc.anything({ withMap: true, withSet: true }), (value) => {
        try {
          const json = serializeProps(value, 262_144, {
            allowSensitiveKeys: true,
          });
          expect(typeof json).toBe('string');
          expect(hasForbiddenKey(JSON.parse(json))).toBe(false);
        } catch (error) {
          expect(error).toBeInstanceOf(IslandError);
        }
        expect(polluted()).toBe(false);
      }),
      runs,
    );
  });

  it('closed object schemas reject every undeclared key, including prototype keys', () => {
    const schema = {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 40 },
        count: { type: 'integer', minimum: 0, maximum: 10 },
      },
      required: ['label'],
    } as const;
    fc.assert(
      fc.property(jsonProps, (props) => {
        const problem = checkIslandProps(schema, props);
        const keys = Object.keys(props);
        const declared =
          keys.every((key) => key === 'label' || key === 'count') &&
          keys.includes('label');
        if (!declared) expect(problem).toBeDefined();
        expect(polluted()).toBe(false);
      }),
      runs,
    );
  });
});

describe('island signatures (server)', () => {
  it('verifies exactly the signed id and props, and nothing tampered', () => {
    fc.assert(
      fc.property(
        jsonProps.filter((props) => !hasForbiddenKey(props)),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 3 }),
        (props, position, replacement) => {
          const islands = registry();
          let json: string;
          try {
            json = serializeProps(props, 32_768);
          } catch {
            return;
          }
          const token = islands.signProps('signed', json);
          expect(islands.verifyProps('signed', json, token)).toEqual(
            JSON.parse(json),
          );
          // Another island's id never accepts the token.
          expect(() => islands.verifyProps('other', json, token)).toThrow(
            IslandError,
          );
          // Any change to the props JSON breaks the signature.
          const at = position % json.length;
          const tampered = json.slice(0, at) + replacement + json.slice(at + 1);
          if (tampered !== json)
            expect(() =>
              islands.verifyProps('signed', tampered, token),
            ).toThrow(IslandError);
          // So does any change to the MAC.
          const mac = token.slice(token.lastIndexOf('.') + 1);
          // Not the last character: its low bits are base64 padding.
          const index = position % (mac.length - 1);
          const flipped = mac[index] === 'A' ? 'g' : 'A';
          const forged =
            token.slice(0, token.length - mac.length) +
            mac.slice(0, index) +
            flipped +
            mac.slice(index + 1);
          expect(() => islands.verifyProps('signed', json, forged)).toThrow(
            IslandError,
          );
        },
      ),
      runs,
    );
  });

  it('rejects arbitrary tokens and props with IslandError only', () => {
    const islands = registry();
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 80 }),
          fc
            .tuple(
              fc.stringMatching(/^\d{1,12}$/),
              fc.stringMatching(/^\d{1,12}$/),
              fc.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            )
            .map(([iat, exp, mac]) => `v1.${iat}.${exp}.${mac}`),
          fc.anything(),
        ),
        fc.oneof(fc.string({ maxLength: 80 }), fc.anything()),
        (token, json) => {
          expect(() =>
            islands.verifyProps('signed', json as string, token as string),
          ).toThrow(IslandError);
          expect(polluted()).toBe(false);
        },
      ),
      runs,
    );
  });

  it('expires tokens and keeps verifying across key rotation', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (seconds, start) => {
          let now = 1_700_000_000_000 + start * 1000;
          const old = registry(() => now);
          const json = serializeProps({ n: seconds }, 1024);
          const token = old.signProps('signed', json);
          const rotated = new IslandRegistry(
            [{ id: 'signed', framework: 'custom', signed: true }],
            { signingKeys: [keyB, keyA], now: () => now },
          );
          expect(rotated.verifyProps('signed', json, token)).toEqual({
            n: seconds,
          });
          const retired = new IslandRegistry(
            [{ id: 'signed', framework: 'custom', signed: true }],
            { signingKeys: [keyB], now: () => now },
          );
          expect(() => retired.verifyProps('signed', json, token)).toThrow(
            IslandError,
          );
          now += 3_600_000 + seconds * 1000;
          expect(() => old.verifyProps('signed', json, token)).toThrow(
            /expired/,
          );
        },
      ),
      runs,
    );
  });
});

describe('island manifest and shared context parsers', () => {
  it('parse or throw an Error for any input, never polluting prototypes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({
            version: fc.constantFrom(1, 2, '1'),
            islands: fc.dictionary(
              fc.oneof(propKey, fc.string({ maxLength: 10 })),
              fc.anything(),
            ),
          }),
          fc.constant(JSON.parse('{"__proto__":{"polluted":1}}')),
        ),
        (value) => {
          for (const parse of [parseIslandManifest, parseSharedContext]) {
            try {
              parse(value);
            } catch (error) {
              expect(error).toBeInstanceOf(Error);
            }
          }
          expect(polluted()).toBe(false);
        },
      ),
      runs,
    );
  });
});

declare global {
  interface Window {
    nvIslandsClient: typeof import('../packages/islands/dist/client.js');
    __pwned?: number;
  }
}

describe('island hydration in the browser (Chromium)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    const result = await build({
      entryPoints: ['packages/islands/dist/client.js'],
      bundle: true,
      format: 'iife',
      globalName: 'nvIslandsClient',
      write: false,
      logLevel: 'silent',
    });
    page = await browser.newPage();
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? '' });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /**
   * Inserts `html` (with innerHTML, so any injected handler would run),
   * mounts the `probe` island and reports what it received.
   */
  const hydrate = (html: string) =>
    page.evaluate(async (markup) => {
      document.body.innerHTML = markup;
      const received: unknown[] = [];
      const errors: string[] = [];
      const loader = window.nvIslandsClient.createIslands({
        modules: {
          probe: async () => (_element, props) => {
            received.push({
              props: JSON.stringify(props),
              prototype: Object.getPrototypeOf(props) === Object.prototype,
              frozen: Object.isFrozen(props),
            });
            return () => undefined;
          },
        },
        onError: (error) => errors.push(String(error)),
      });
      loader.start();
      const end = performance.now() + 2_000;
      while (!received.length && !errors.length && performance.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 5));
      // Handlers from injected markup (onerror, onload) run asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 20));
      loader.dispose();
      return {
        received,
        errors,
        pwned: window.__pwned ?? 0,
        scripts: document.body.querySelectorAll('script').length,
        polluted:
          Reflect.get(Object.prototype, 'polluted') !== undefined ||
          Reflect.get(Object.prototype, 'isAdmin') !== undefined,
      };
    }, html);

  it('hydrates server-rendered hostile props as inert data, unchanged', async () => {
    const islands = registry();
    await fc.assert(
      fc.asyncProperty(
        jsonProps.filter(
          (props) => !hasForbiddenKey(props) && !hasSensitiveKey(props),
        ),
        async (props) => {
          const html = islands.render('probe', props, {
            fallback: '<b>fallback</b>',
          }).value;
          const outcome = await hydrate(html);
          expect(outcome.errors).toEqual([]);
          expect(outcome.received).toEqual([
            {
              props: JSON.stringify(JSON.parse(JSON.stringify(props))),
              prototype: true,
              frozen: true,
            },
          ]);
          expect(outcome).toMatchObject({
            pwned: 0,
            polluted: false,
            scripts: 0,
          });
        },
      ),
      browserRuns,
    );
  }, 120_000);

  it('rejects or neutralizes hostile hydration attributes written by an attacker', async () => {
    const attribute = fc.oneof(
      hostile,
      fc.constantFrom(
        '{"__proto__":{"polluted":1}}',
        '{"constructor":{"prototype":{"isAdmin":true}}}',
        '[1,2,3]',
        'null',
        '"string"',
        '{"a":',
        '1e309',
        `{"big":"${'x'.repeat(300_000)}"}`,
      ),
      jsonProps.map((props) => JSON.stringify(props)),
    );
    await fc.assert(
      fc.asyncProperty(attribute, async (raw) => {
        const escaped = raw
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;');
        const outcome = await hydrate(
          `<div data-nv-island="probe" data-nv-framework="custom" data-nv-mount="immediate" data-nv-props="${escaped}">x</div>`,
        );
        expect(outcome).toMatchObject({
          pwned: 0,
          polluted: false,
          scripts: 0,
        });
        // Either refused with an error, or mounted with plain own data.
        expect(outcome.received.length + outcome.errors.length).toBe(1);
        for (const entry of outcome.received)
          expect(entry).toMatchObject({ prototype: true, frozen: true });
      }),
      browserRuns,
    );
  }, 120_000);
});
