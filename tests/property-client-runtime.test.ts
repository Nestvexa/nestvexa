/**
 * Browser-runtime fuzzing of the Live client. fast-check generates directive
 * attributes, server HTML fragments and transport replies in Node; every run
 * executes in a real browser against the built `@nestvexa/client` modules
 * (`packages/client/dist`). Chromium by default; `NV_FUZZ_BROWSERS` selects
 * more engines (the nightly workflow runs `chromium,firefox,webkit`).
 *
 * The oracles are independent of the client implementation:
 * - active content is judged by browser semantics (the WHATWG URL parser for
 *   navigation schemes, `on*` names that are real event handler properties,
 *   script-capable elements and foreign namespaces);
 * - every hostile payload calls `nvPwn()`; the page must never record a call;
 * - duplicate sibling keys are computed from the parsed DOM;
 * - an accepted morph must equal the server fragment, keep keyed identity and
 *   be idempotent (a second identical morph causes zero DOM mutations);
 * - a rejected response must leave DOM, markers and client state unchanged.
 */
import fc from 'fast-check';
import { chromium, firefox, webkit } from '@playwright/test';
import type { Browser, BrowserType, Page } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type {
  LiveClient,
  LiveClientOptions,
} from '../packages/client/dist/index.js';
import {
  propertyRunMultiplier,
  propertyRuns,
} from './support/property-runs.js';

interface FuzzModules {
  readonly morph: {
    validateFragment(fragment: DocumentFragment): void;
    morphChildren(
      parent: Element,
      incoming: DocumentFragment,
      dirty: ReadonlyMap<string, unknown>,
    ): void;
  };
  readonly client: {
    createLiveClient(options: LiveClientOptions): LiveClient;
    parseDirective(name: string, value: string): unknown;
  };
}
declare global {
  interface Window {
    nvFuzz: FuzzModules;
    nvPwn(id: unknown): void;
    nvPwned: string[];
    nvPageErrors: string[];
    nvActive(root: ParentNode): string[];
    nvDuplicateKeys(root: ParentNode): boolean;
    nvParse(html: string): HTMLTemplateElement;
    nvSettle(): Promise<void>;
    nvCode(error: unknown): string;
  }
}

const engines: Readonly<Record<string, BrowserType>> = {
  chromium,
  firefox,
  webkit,
};
const selected = (process.env['NV_FUZZ_BROWSERS'] ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of selected)
  if (!Object.hasOwn(engines, name))
    throw new Error(`Unknown NV_FUZZ_BROWSERS entry: ${name}`);

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      // No CSP on purpose: a hostile handler that slipped through must run
      // and be recorded by nvPwn(), not be silently blocked by policy.
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><title>Client fuzz fixture</title><script type="module" src="/fixture.js"></script><body><main></main></body></html>',
      );
      return;
    }
    if (pathname === '/fixture.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
      });
      response.end(
        "import * as morph from '/morph.js'; import * as client from '/index.js'; globalThis.nvFuzz = { morph, client };",
      );
      return;
    }
    // Test-only static server for built client modules; nothing else is served.
    if (!/^\/[a-z-]+\.js$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL(`../packages/client/dist${pathname}`, import.meta.url),
      'utf8',
    ).then(
      (source) => {
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
        });
        response.end(source);
      },
      () => {
        response.writeHead(404).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fuzz server port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

/** In-page oracles, installed before any page script runs. */
function installOracles(): void {
  window.nvPwned = [];
  window.nvPageErrors = [];
  window.nvPwn = (id) => {
    window.nvPwned.push(String(id));
  };
  window.addEventListener('error', (event) => {
    // Resource load failures (404 images) are not script errors.
    if (event instanceof ErrorEvent)
      window.nvPageErrors.push(String(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.nvPageErrors.push(`unhandled: ${String(event.reason)}`);
  });
  const xhtml = 'http://www.w3.org/1999/xhtml';
  const activeElements = new Set([
    'script',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'base',
    'meta',
    'link',
    'portal',
    'fencedframe',
    'applet',
  ]);
  const navigating = new Set(['href', 'action', 'formaction', 'xlink:href']);
  const framing = new Set(['iframe', 'frame', 'embed', 'script']);
  const executable = new Set(['javascript:', 'vbscript:', 'data:']);
  window.nvActive = (root) => {
    const found: string[] = [];
    for (const element of root.querySelectorAll('*')) {
      const tag = element.localName.toLowerCase();
      if (element.namespaceURI !== xhtml) found.push(`namespace:${tag}`);
      if (activeElements.has(tag)) found.push(`element:${tag}`);
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') && name in element)
          found.push(`handler:${name}`);
        if (name === 'srcdoc') found.push('srcdoc');
        if (navigating.has(name) || (name === 'src' && framing.has(tag))) {
          let protocol = '';
          try {
            protocol = new URL(attribute.value, document.baseURI).protocol;
          } catch {
            // Unparseable URLs never navigate.
          }
          if (executable.has(protocol)) found.push(`url:${name}`);
        }
      }
    }
    return found;
  };
  const keyOf = (node: Node): string | undefined => {
    if (!(node instanceof Element)) return undefined;
    for (const name of [
      'data-nv-key',
      'data-nv-component',
      'data-nv-island',
      'id',
    ]) {
      const value = node.getAttribute(name);
      if (value) return `${name}:${value}`;
    }
    return undefined;
  };
  window.nvDuplicateKeys = (root) => {
    const seen = new Set<string>();
    for (const node of root.childNodes) {
      const key = keyOf(node);
      if (key !== undefined) {
        if (seen.has(key)) return true;
        seen.add(key);
      }
      if (node instanceof Element && window.nvDuplicateKeys(node)) return true;
    }
    return false;
  };
  // morph.js and the index.js bundle are separate module instances, so
  // classify client errors by name and code instead of instanceof.
  window.nvCode = (error) =>
    error instanceof Error &&
    ['LiveClientError', 'LiveHttpError'].includes(error.name) &&
    typeof Reflect.get(error, 'code') === 'string'
      ? String(Reflect.get(error, 'code'))
      : `foreign:${String(error)}`;
  window.nvParse = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template;
  };
  // Let image error events and queued tasks run before checking the sentinel.
  window.nvSettle = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
}

async function openPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(installOracles);
  // Generous bounds: cold Firefox/WebKit starts are slow on loaded runners.
  await page.goto(base, { timeout: 120_000 });
  await page.waitForFunction(() => Reflect.has(globalThis, 'nvFuzz'), null, {
    timeout: 120_000,
  });
  return page;
}

// ---------------------------------------------------------------------------
// Generators

const payload = fc.nat({ max: 999 }).map((id) => `nvPwn(${id})`);
/** Executable URLs, including parser-normalized obfuscations. */
const hostileUrl = fc.oneof(
  payload.map((code) => `javascript:${code}`),
  payload.map((code) => ` \tJAVASCRIPT:${code}`),
  payload.map((code) => `java\tscript:${code}`),
  payload.map((code) => `java&#x09;script:${code}`),
  payload.map((code) => `jav&#x0A;ascript:${code}`),
  payload.map((code) => `&#106;avascript:${code}`),
  payload.map((code) => `javascript&colon;${code}`),
  payload.map((code) => `\u0001javascript:${code}`),
  payload.map((code) => `vbscript:${code}`),
  payload.map((code) => `data:text/html,&lt;script&gt;${code}&lt;/script&gt;`),
);
/** Look-alikes that are relative or inert and must be harmless either way. */
const benignUrl = fc.constantFrom(
  '/items/1',
  '#top',
  '?page=2',
  'https://example.test/a',
  '/javascript:nvPwn(1)',
  '#javascript:nvPwn(1)',
  '\u00a0javascript:nvPwn(1)',
  'mailto:a@example.test',
  '',
);
const text = fc
  .string({ unit: 'binary', maxLength: 12 })
  .map((value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
const quoted = (value: string): string => value.replace(/"/g, '&quot;');
const key = fc.constantFrom('a', 'b', 'c', 'd');
/** Attributes for safe-by-construction elements (morph equivalence). */
const plainAttribute = fc.oneof(
  key.map((value) => `data-nv-key="${value}"`),
  key.map((value) => `id="k-${value}"`),
  fc.constantFrom('class="x"', 'class="x y"', 'hidden', 'title="t"'),
  fc
    .tuple(fc.stringMatching(/^[a-z][a-z-]{0,6}$/), text)
    .filter(([name]) => !name.startsWith('on') && !name.startsWith('nv'))
    .map(([name, value]) => `data-${name}="${quoted(value)}"`),
  benignUrl.map((value) => `href="${quoted(value)}"`),
  fc.constantFrom('aria-label="Label"', 'role="status"', 'tabindex="0"'),
);
const hostileAttribute = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(
        'onclick',
        'onerror',
        'onload',
        'onfocus',
        'onmouseover',
        'ONERROR',
        'OnLoad',
        'ontoggle',
        'onanimationstart',
      ),
      payload,
    )
    .map(([name, code]) => `${name}="${code}"`),
  fc
    .tuple(
      fc.constantFrom('href', 'action', 'formaction', 'src', 'xlink:href'),
      hostileUrl,
    )
    .map(([name, value]) => `${name}="${quoted(value)}"`),
  payload.map((code) => `srcdoc="&lt;script&gt;${code}&lt;/script&gt;"`),
);
const plainTag = fc.constantFrom(
  'div',
  'span',
  'p',
  'ul',
  'li',
  'b',
  'em',
  'section',
  'label',
  'button',
  'a',
  'output',
  'small',
  'details',
  'summary',
  'pre',
  'code',
  'h2',
);
const voidTag = fc.constantFrom('img', 'input', 'br', 'hr');
const hostileTag = fc.constantFrom(
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'svg',
  'math',
  'frame',
  'frameset',
  'template',
  'noscript',
  'style',
  'img',
  'form',
);

// A type alias (not an interface) so fc.letrec's strongly typed overload applies.
type Tree = { readonly node: string };
function element(
  tag: fc.Arbitrary<string>,
  attribute: fc.Arbitrary<string>,
  child: fc.Arbitrary<string>,
): fc.Arbitrary<string> {
  return fc
    .tuple(
      tag,
      fc.uniqueArray(attribute, {
        maxLength: 3,
        selector: (value) => value.split('=')[0]?.toLowerCase(),
      }),
      fc.array(child, { maxLength: 4 }),
    )
    .map(([name, attributes, children]) => {
      const open = [name, ...attributes].join(' ');
      return [
        'img',
        'input',
        'br',
        'hr',
        'base',
        'meta',
        'link',
        'embed',
      ].includes(name)
        ? `<${open}>`
        : `<${open}>${children.join('')}</${name}>`;
    });
}
/** Fragments that contain no hostile construct by construction. */
const plainNode = fc.letrec<Tree>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    text,
    element(voidTag, plainAttribute, fc.constant('')),
    element(plainTag, plainAttribute, tie('node')),
  ),
})).node;
const plainFragment: fc.Arbitrary<string> = fc
  .array(plainNode, { maxLength: 5 })
  .map((nodes) => nodes.join(''));
/** Fragments that mix plain markup with hostile elements and attributes. */
const hostileFragment: fc.Arbitrary<string> = fc
  .array(
    fc.letrec<Tree>((tie) => ({
      node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        text,
        element(voidTag, fc.oneof(plainAttribute, hostileAttribute), text),
        element(
          fc.oneof(plainTag, hostileTag),
          fc.oneof(plainAttribute, hostileAttribute),
          tie('node'),
        ),
        payload.map((code) => `<script>${code}</script>`),
        payload.map((code) => `<img src="/missing.png" onerror="${code}">`),
        payload.map((code) => `<svg><a href="javascript:${code}">x</a></svg>`),
      ),
    })).node,
    { maxLength: 5 },
  )
  .map((nodes) => nodes.join(''));
const fragment = fc.oneof(plainFragment, hostileFragment);

// ---------------------------------------------------------------------------

// Each property evaluates hundreds of cases in the page; scale with the run budget.
const fuzzTimeout = 180_000 * propertyRunMultiplier();

describe.each(selected)(
  'Live client runtime fuzzing (%s)',
  (engine) => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      const launcher = engines[engine];
      if (!launcher) throw new Error(`Unknown engine ${engine}`);
      browser = await launcher.launch();
    }, 300_000);
    // Closing the browser also closes every page opened below.
    afterAll(async () => {
      await browser?.close();
    }, 300_000);
    // A fresh page per property: no DOM, timers or heap carried between them.
    beforeEach(async () => {
      page = await openPage(browser);
    }, 300_000);
    async function expectQuietPage(): Promise<void> {
      const status = await page.evaluate(async () => {
        await window.nvSettle();
        const pwned = window.nvPwned.splice(0);
        const errors = window.nvPageErrors.splice(0);
        const polluted = Object.keys(Object.prototype);
        return { pwned, errors, polluted };
      });
      expect(status).toEqual({ pwned: [], errors: [], polluted: [] });
    }

    it('directive parsing is a closed, deterministic data-only grammar', async () => {
      const bases = [
        'click',
        'submit',
        'keydown',
        'model',
        'init',
        'loading',
        'ignore',
        'target',
        'replace',
        'confirm',
        'text',
        'show',
        'bind',
        'dirty',
        'cloak',
        'ref',
        'sort',
        'navigate',
        'optimistic',
        'stream',
        'upload',
        'poll',
        'intersect',
        'offline',
        'current',
        'transition',
      ];
      const modifier = fc.oneof(
        fc.constantFrom(
          'prevent',
          'stop',
          'self',
          'once',
          'debounce',
          'throttle',
          '500ms',
          '1s',
          '0ms',
          '99999999ms',
          'enter',
          'escape',
          'ctrl',
          'shift',
          'window',
          'document',
          'live',
          'blur',
          'change',
          'lazy',
          'number',
          'boolean',
          'class',
          'attr',
          'remove',
          'delay',
          'longest',
          'visible',
          'idle',
          'except',
          'handle',
          'group',
          'keep-alive',
          '',
          '__proto__',
          'constructor',
        ),
        fc.stringMatching(/^[a-zA-Z0-9-]{1,8}$/),
      );
      const directiveName = fc.oneof(
        fc
          .tuple(
            fc.oneof(
              fc.constantFrom(...bases),
              fc.stringMatching(/^[a-z]{1,9}$/),
            ),
            fc.array(modifier, { maxLength: 4 }),
          )
          .map(([name, modifiers]) => ['nv:' + name, ...modifiers].join('.')),
        fc.string({ unit: 'binary', maxLength: 16 }),
        fc.constantFrom(
          'nv:',
          'NV:click',
          'x-nv:click',
          'nv:click ',
          'nv:CLICK',
        ),
      );
      const directiveValue = fc.oneof(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,10}$/),
        fc
          .array(fc.stringMatching(/^[a-z]{1,6}$/), {
            minLength: 1,
            maxLength: 10,
          })
          .map((parts) => parts.join('.')),
        fc.constantFrom(
          '',
          'alert(1)',
          'nvPwn(1)',
          '__proto__',
          'constructor',
          'prototype',
          'a.__proto__.b',
          'javascript:nvPwn(1)',
          '{"x":1}',
          '[1,2]',
          'active: isOpen',
          'count > 1',
          '${nvPwn(1)}',
          '#id',
          '.cls',
          'a b',
          '1e309',
          '-1',
        ),
        fc.json({ maxDepth: 2 }),
        fc.string({ unit: 'binary', maxLength: 40 }),
        fc.string({ maxLength: 200 }),
      );
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(directiveName, directiveValue), {
            minLength: 1,
            maxLength: 40,
          }),
          async (cases) => {
            const results = await page.evaluate((input) => {
              const { parseDirective } = window.nvFuzz.client;
              const run = (name: string, value: string): string => {
                try {
                  return JSON.stringify({ ok: parseDirective(name, value) });
                } catch (error) {
                  return JSON.stringify({
                    error: window.nvCode(error),
                  });
                }
              };
              return input.map(([name, value]) => {
                const first = run(name, value);
                const second = run(name, value);
                return { name, first, second };
              });
            }, cases);
            for (const { name, first, second } of results) {
              // Deterministic and representable as plain JSON data.
              expect(second).toBe(first);
              const parsed = JSON.parse(first) as {
                ok?: { kind?: unknown };
                error?: string;
              };
              if (parsed.error !== undefined) {
                expect(parsed.error).toBe('DIRECTIVE');
                continue;
              }
              // Accepted only for an nv: name with a known base directive.
              const directiveBase = /^nv:([a-z]+)(?:\.|$)/.exec(name)?.[1];
              expect(bases).toContain(directiveBase);
              expect(typeof parsed.ok?.kind).toBe('string');
            }
            await expectQuietPage();
          },
        ),
        propertyRuns(40),
      );
    });

    it('validateFragment rejects every browser-executable construct and morphing never runs script', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fragment, { minLength: 1, maxLength: 12 }),
          async (fragments) => {
            const results = await page.evaluate((input) => {
              const { validateFragment, morphChildren } = window.nvFuzz.morph;
              return input.map((html) => {
                const template = window.nvParse(html);
                const active = window.nvActive(template.content);
                let accepted = true;
                let code = '';
                try {
                  validateFragment(template.content);
                } catch (error) {
                  accepted = false;
                  code = window.nvCode(error);
                }
                let live: string[] = [];
                if (accepted) {
                  const container = document.createElement('div');
                  document.body.append(container);
                  try {
                    morphChildren(container, template.content, new Map());
                  } catch (error) {
                    const thrown = window.nvCode(error);
                    if (thrown.startsWith('foreign:')) code = thrown;
                  }
                  live = window.nvActive(container);
                  container.remove();
                }
                return { html, active, accepted, code, live };
              });
            }, fragments);
            for (const result of results) {
              if (result.active.length)
                expect(result).toMatchObject({
                  accepted: false,
                  code: 'HTML',
                });
              if (!result.accepted) expect(result.code).toBe('HTML');
              expect(result.code.startsWith('foreign:')).toBe(false);
              expect(result.live).toEqual([]);
            }
            await expectQuietPage();
          },
        ),
        propertyRuns(60),
      );
    });

    it('morphing is exact, keyed-identity preserving, atomic on rejection and idempotent', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(plainFragment, plainFragment), {
            minLength: 1,
            maxLength: 10,
          }),
          async (pairs) => {
            const results = await page.evaluate((input) => {
              const { morphChildren } = window.nvFuzz.morph;
              const keyOf = (node: Element): string | undefined =>
                node.getAttribute('data-nv-key')
                  ? `k:${node.getAttribute('data-nv-key')}`
                  : node.getAttribute('id')
                    ? `i:${node.getAttribute('id')}`
                    : undefined;
              const outcome = (run: () => void): string => {
                try {
                  run();
                  return 'ok';
                } catch (error) {
                  return window.nvCode(error);
                }
              };
              return input.map(([first, second]) => {
                const container = document.createElement('div');
                document.body.append(container);
                const initial = window.nvParse(first);
                const initialDuplicate = window.nvDuplicateKeys(
                  initial.content,
                );
                const seeded = outcome(() =>
                  morphChildren(container, initial.content, new Map()),
                );
                const seededHtml = container.innerHTML;
                const next = window.nvParse(second);
                const expected = next.innerHTML;
                const duplicate =
                  window.nvDuplicateKeys(container) ||
                  window.nvDuplicateKeys(next.content);
                const before = new Map<string, Element>();
                for (const child of container.children) {
                  const id = keyOf(child);
                  if (id) before.set(id, child);
                }
                const beforeHtml = container.innerHTML;
                const morphed = outcome(() =>
                  morphChildren(container, next.content, new Map()),
                );
                const afterHtml = container.innerHTML;
                // DOM equality ignores attribute order (a morph appends new
                // attributes, so serializations may legitimately differ).
                const reference = document.createElement('div');
                reference.append(next.content.cloneNode(true));
                const afterEqual = reference.isEqualNode(container);
                let lostIdentity = 0;
                let mutations = -1;
                if (morphed === 'ok') {
                  for (const child of container.children) {
                    const id = keyOf(child);
                    const previous = id ? before.get(id) : undefined;
                    if (
                      previous &&
                      previous.tagName === child.tagName &&
                      previous !== child
                    )
                      lostIdentity++;
                  }
                  const observer = new MutationObserver(() => undefined);
                  observer.observe(container, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    characterData: true,
                  });
                  morphChildren(
                    container,
                    window.nvParse(second).content,
                    new Map(),
                  );
                  mutations = observer.takeRecords().length;
                  observer.disconnect();
                }
                container.remove();
                return {
                  first,
                  second,
                  initialDuplicate,
                  seeded,
                  seededHtml,
                  expectedSeed: initial.innerHTML,
                  duplicate,
                  beforeHtml,
                  morphed,
                  afterHtml,
                  afterEqual,
                  expected,
                  lostIdentity,
                  mutations,
                };
              });
            }, pairs);
            for (const result of results) {
              // Seeding an empty container: exact iff keys are unique.
              expect(result.seeded).toBe(
                result.initialDuplicate ? 'HTML' : 'ok',
              );
              expect(result.seededHtml).toBe(
                result.initialDuplicate ? '' : result.expectedSeed,
              );
              if (result.duplicate) {
                expect(result.morphed).toBe('HTML');
                expect(result.afterHtml).toBe(result.beforeHtml);
                continue;
              }
              expect(result.morphed).toBe('ok');
              expect(result.afterEqual, JSON.stringify(result)).toBe(true);
              expect(result.lostIdentity).toBe(0);
              expect(result.mutations).toBe(0);
            }
            await expectQuietPage();
          },
        ),
        propertyRuns(50),
      );
    });

    it('hostile or malformed server replies are applied atomically or rejected without side effects', async () => {
      const transport = fc.oneof(
        { weight: 6, arbitrary: fc.constant({ kind: 'ok' as const }) },
        fc.record({
          kind: fc.constant('status' as const),
          status: fc.oneof(
            fc.integer({ min: 300, max: 599 }),
            fc.constant(426),
          ),
        }),
        fc.record({
          kind: fc.constant('contentType' as const),
          value: fc.constantFrom(
            'text/html',
            'text/json',
            'application/json5',
            'application/jsonp',
            'application/x-json',
            'application/json-seq',
            '',
          ),
        }),
        fc.record({
          kind: fc.constant('body' as const),
          value: fc.oneof(
            fc.string({ unit: 'binary', maxLength: 60 }),
            fc.json({ maxDepth: 3 }),
            fc.constantFrom(
              '{"protocol":"nestvexa-live/1"',
              '<html><script>nvPwn(7)</script>',
              'null',
              '[]',
              '{"__proto__":{"polluted":"yes"}}',
            ),
          ),
        }),
        fc.constant({ kind: 'invalidUtf8' as const }),
        fc.record({
          kind: fc.constant('protocolHeader' as const),
          value: fc.constantFrom('nestvexa-live/2', 'nestvexa-live/0', 'x'),
        }),
        fc.constant({ kind: 'oversized' as const }),
      );
      const known = [
        'requestId',
        'revision',
        'componentId',
        'componentName',
        'protocol',
        'snapshot',
        'stateKey',
        'redirect',
        'events',
        'download',
        'realtime',
        'renderless',
        'proto',
      ] as const;
      const mutation = fc.oneof(
        { weight: 6, arbitrary: fc.constant({ kind: 'none' as const }) },
        fc.record({
          kind: fc.constantFrom(...known),
          variant: fc.nat({ max: 5 }),
        }),
        fc.record({
          kind: fc.constant('replace' as const),
          field: fc.constantFrom(
            'protocol',
            'requestId',
            'component',
            'snapshot',
            'state',
            'html',
            'url',
            'events',
            'extra',
          ),
          value: fc.jsonValue({ maxDepth: 3 }),
        }),
      );
      type Spec = {
        transport: { kind: string; status?: number; value?: string };
        mutation: {
          kind: string;
          variant?: number;
          field?: string;
          value?: unknown;
        };
        html: string;
        /** Generated without any hostile construct (liveness oracle). */
        plain: boolean;
        count: number;
      };
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc
              .record({
                transport,
                mutation,
                source: fc.oneof(
                  plainFragment.map((html) => ({ html, plain: true })),
                  hostileFragment.map((html) => ({ html, plain: false })),
                ),
                count: fc.integer({ min: -5, max: 5000 }),
              })
              .map(({ source, ...rest }) => ({ ...rest, ...source })),
            { minLength: 1, maxLength: 8 },
          ),
          async (specs: Spec[]) => {
            const results = await page.evaluate(async (input) => {
              const { createLiveClient } = window.nvFuzz.client;
              const out = [];
              let index = 0;
              for (const spec of input) {
                index++;
                const host = document.createElement('div');
                const root = document.createElement('div');
                const id = `fuzz-${Date.now()}-${index}`;
                root.setAttribute('data-nv-component', id);
                root.setAttribute('data-nv-name', 'fuzz');
                root.setAttribute('data-nv-endpoint', '/_live/fuzz');
                root.setAttribute('data-nv-csrf', 'c'.repeat(32));
                root.setAttribute('data-nv-snapshot', 'snapshot-0');
                root.setAttribute('data-nv-revision', '0');
                root.setAttribute('data-nv-state', '{"count":0}');
                root.innerHTML = '<output>0</output>';
                host.append(root);
                document.body.append(host);
                let sent: {
                  snapshot: unknown;
                  revision: unknown;
                  count: unknown;
                } = { snapshot: null, revision: null, count: null };
                const reported: string[] = [];
                const fetchStub = async (
                  _url: RequestInfo | URL,
                  init?: RequestInit,
                ): Promise<Response> => {
                  const request = JSON.parse(String(init?.body)) as {
                    requestId: string;
                    revision: number;
                  };
                  const envelope: Record<string, unknown> = {
                    protocol: 'nestvexa-live/1',
                    requestId: request.requestId,
                    component: {
                      id,
                      name: 'fuzz',
                      revision: request.revision + 1,
                    },
                    snapshot: 'snapshot-1',
                    state: { count: spec.count },
                    html: spec.html,
                  };
                  const component = envelope['component'] as Record<
                    string,
                    unknown
                  >;
                  const variant = spec.mutation.variant ?? 0;
                  let raw: string | undefined;
                  switch (spec.mutation.kind) {
                    case 'requestId':
                      envelope['requestId'] = [
                        '',
                        'other',
                        request.requestId.toUpperCase() + 'x',
                        'x'.repeat(129),
                      ][variant % 4];
                      break;
                    case 'revision':
                      component['revision'] = [
                        request.revision,
                        request.revision + 2,
                        -1,
                        1.5,
                        '1',
                        Number.MAX_SAFE_INTEGER + 2,
                      ][variant];
                      break;
                    case 'componentId':
                      component['id'] = ['', 'other', null, `${id} `][
                        variant % 4
                      ];
                      break;
                    case 'componentName':
                      component['name'] = ['other', 'Fuzz', '__proto__', '', 7][
                        variant % 5
                      ];
                      break;
                    case 'protocol':
                      envelope['protocol'] = ['nestvexa-live/2', '', null][
                        variant % 3
                      ];
                      break;
                    case 'snapshot':
                      envelope['snapshot'] = ['', 1, null, 'x'.repeat(65_537)][
                        variant % 4
                      ];
                      break;
                    case 'stateKey':
                      envelope['state'] = [
                        { 'a.b': 1 },
                        { '1x': 1 },
                        { constructor: 1 },
                        [],
                        null,
                        { 'x y': 1 },
                      ][variant];
                      break;
                    case 'redirect':
                      envelope['redirect'] = [
                        '//evil.example/',
                        'javascript:nvPwn(5)',
                        'https://evil.example/',
                        '/\\evil.example',
                        '/a\nb',
                        '\\\\evil',
                      ][variant];
                      break;
                    case 'events':
                      envelope['events'] = [
                        [{ name: 'Bad', payload: 1 }],
                        Array.from({ length: 17 }, () => ({
                          name: 'ok',
                          payload: 1,
                        })),
                        [{ name: 'ok', payload: 1, to: 'x', self: true }],
                        [{ name: 'ok' }],
                        [{ name: 'ok', payload: 1, extra: 1 }],
                        'ok',
                      ][variant];
                      break;
                    case 'download':
                      envelope['download'] = [
                        {
                          url: 'https://evil.example/_download/x',
                          filename: 'a',
                        },
                        { url: `/_download/${'a'.repeat(43)}`, filename: '' },
                        {
                          url: `//e/_download/${'a'.repeat(43)}`,
                          filename: 'a',
                        },
                        { url: `/_download/${'a'.repeat(42)}`, filename: 'a' },
                        'x',
                        {
                          url: `/_download/${'a'.repeat(43)}`,
                          filename: 'a',
                          x: 1,
                        },
                      ][variant];
                      break;
                    case 'realtime':
                      envelope['realtime'] = [
                        'x',
                        '',
                        'a.b',
                        1,
                        'a.' + '!'.repeat(30),
                      ][variant % 5];
                      break;
                    case 'renderless':
                      envelope['renderless'] = variant % 2 ? 'yes' : true;
                      envelope['html'] = `<p>${spec.html}</p>`;
                      break;
                    case 'proto':
                      raw = JSON.stringify(envelope).replace(
                        '"state":{',
                        '"state":{"__proto__":{"polluted":"yes"},',
                      );
                      raw = raw.replace(
                        '{',
                        '{"__proto__":{"polluted":"yes"},',
                      );
                      break;
                    case 'replace':
                      envelope[spec.mutation.field ?? 'extra'] =
                        spec.mutation.value;
                      break;
                  }
                  const body = raw ?? JSON.stringify(envelope);
                  const state = envelope['state'];
                  sent = {
                    snapshot: envelope['snapshot'],
                    revision: component['revision'],
                    count:
                      state && typeof state === 'object'
                        ? Reflect.get(state, 'count')
                        : undefined,
                  };
                  const headers: Record<string, string> = {
                    'content-type': 'application/json; charset=utf-8',
                  };
                  const t = spec.transport;
                  if (t.kind === 'status')
                    return new Response(body, {
                      status: t.status ?? 500,
                      headers,
                    });
                  if (t.kind === 'contentType')
                    return new Response(body, {
                      headers: { 'content-type': t.value ?? '' },
                    });
                  if (t.kind === 'body')
                    return new Response(t.value ?? '', { headers });
                  if (t.kind === 'invalidUtf8') {
                    const bytes = new TextEncoder().encode(body);
                    const broken = new Uint8Array(bytes.length + 2);
                    broken.set(bytes.subarray(0, 1));
                    broken.set([0xff, 0xfe], 1);
                    broken.set(bytes.subarray(1), 3);
                    return new Response(broken, { headers });
                  }
                  if (t.kind === 'protocolHeader')
                    return new Response(body, {
                      headers: {
                        ...headers,
                        'x-nestvexa-protocol': t.value ?? '',
                      },
                    });
                  if (t.kind === 'oversized')
                    return new Response(
                      body.replace(
                        '"html":',
                        `"pad":"${'x'.repeat(2_097_152)}","html":`,
                      ),
                      { headers },
                    );
                  return new Response(body, { headers });
                };
                const client = createLiveClient({
                  root: host,
                  fetch: fetchStub,
                  onError: (error) => {
                    reported.push(window.nvCode(error));
                  },
                  confirm: () => Promise.resolve(false),
                });
                client.mount();
                // A reply may legitimately replace the public state with one
                // that has no `count` field; get() then throws by design.
                const readCount = (): unknown => {
                  try {
                    return client.get(root, 'count');
                  } catch {
                    return undefined;
                  }
                };
                const before = {
                  html: root.innerHTML,
                  snapshot: root.getAttribute('data-nv-snapshot'),
                  revision: root.getAttribute('data-nv-revision'),
                  count: readCount(),
                };
                let outcome = 'ok';
                try {
                  await client.call(root, 'act');
                } catch (error) {
                  outcome = window.nvCode(error);
                }
                const template = window.nvParse(spec.html);
                const after = {
                  html: root.innerHTML,
                  snapshot: root.getAttribute('data-nv-snapshot'),
                  revision: root.getAttribute('data-nv-revision'),
                  count: readCount(),
                };
                const live = window.nvActive(host);
                client.dispose();
                host.remove();
                out.push({
                  outcome,
                  reported,
                  before,
                  after,
                  sent,
                  expectedHtml: template.innerHTML,
                  hostile: window.nvActive(template.content).length > 0,
                  duplicate: window.nvDuplicateKeys(template.content),
                  live,
                  location: window.location.pathname,
                });
              }
              return out;
            }, specs);
            results.forEach((result, position) => {
              const spec = specs[position];
              if (!spec) throw new Error('Missing spec');
              const contentType =
                spec.transport.kind === 'contentType'
                  ? (spec.transport.value ?? '')
                  : 'application/json';
              const transportOk =
                spec.transport.kind === 'ok' ||
                (spec.transport.kind === 'contentType' &&
                  contentType.split(';')[0]?.trim().toLowerCase() ===
                    'application/json');
              const mustReject =
                !transportOk ||
                (known as readonly string[]).includes(spec.mutation.kind) ||
                result.hostile ||
                result.duplicate;
              const context = { spec, result };
              expect(result.location, JSON.stringify(context)).toBe('/');
              expect(result.live, JSON.stringify(context)).toEqual([]);
              expect(
                result.outcome.startsWith('foreign:'),
                JSON.stringify(context),
              ).toBe(false);
              if (mustReject)
                expect(result.outcome, JSON.stringify(context)).not.toBe('ok');
              // A well-formed reply with safe, uniquely keyed HTML must apply.
              else if (spec.mutation.kind === 'none' && spec.plain)
                expect(result.outcome, JSON.stringify(context)).toBe('ok');
              if (result.outcome === 'ok') {
                expect(result.after, JSON.stringify(context)).toEqual({
                  html: result.expectedHtml,
                  snapshot: result.sent.snapshot,
                  revision: String(result.sent.revision),
                  count: result.sent.count,
                });
                expect(result.reported).toEqual([]);
              } else {
                // Nothing was applied: DOM, markers and client state are unchanged.
                expect(result.after, JSON.stringify(context)).toEqual(
                  result.before,
                );
              }
              // Reported errors are always classified client errors.
              for (const code of result.reported)
                expect(code).toMatch(/^[A-Z]+$/);
            });
            await expectQuietPage();
          },
        ),
        propertyRuns(30),
      );
    });

    it('mounting fuzzed directives and firing events never escapes the client', async () => {
      const attributeName = fc.oneof(
        fc
          .tuple(
            fc.constantFrom(
              'click',
              'keydown',
              'model',
              'init',
              'loading',
              'target',
              'text',
              'show',
              'bind',
              'dirty',
              'cloak',
              'ref',
              'poll',
              'intersect',
              'confirm',
              'replace',
              'ignore',
              'optimistic',
              'transition',
              'current',
              'offline',
              'sort',
            ),
            fc.array(
              fc.constantFrom(
                'prevent',
                'stop',
                'once',
                'debounce',
                '50ms',
                'enter',
                'live',
                'number',
                'class',
                'self',
                'delay',
                'item',
              ),
              { maxLength: 2 },
            ),
          )
          .map(([name, modifiers]) => ['nv:' + name, ...modifiers].join('.')),
      );
      const attributeValue = fc.oneof(
        fc.constantFrom(
          'act',
          'count',
          'nvPwn(1)',
          'javascript:nvPwn(2)',
          '__proto__',
          '',
          'active: count',
          'hidden: count',
          'a.b',
          '{"x":1}',
        ),
        fc.string({ maxLength: 12 }),
      );
      const owned = fc.record({
        tag: fc.constantFrom('button', 'div', 'span', 'input', 'output', 'ul'),
        attributes: fc.uniqueArray(fc.tuple(attributeName, attributeValue), {
          maxLength: 3,
          selector: ([name]) => name,
        }),
      });
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.array(owned, { minLength: 1, maxLength: 5 }), {
            minLength: 1,
            maxLength: 6,
          }),
          async (components) => {
            const result = await page.evaluate(async (input) => {
              const { createLiveClient } = window.nvFuzz.client;
              const requests: string[] = [];
              const reported: string[] = [];
              const host = document.createElement('div');
              document.body.append(host);
              input.forEach((elements, index) => {
                const root = document.createElement('div');
                root.setAttribute('data-nv-component', `mount-${index}`);
                root.setAttribute('data-nv-name', 'fuzz');
                root.setAttribute('data-nv-endpoint', '/_live/fuzz');
                root.setAttribute('data-nv-csrf', 'c'.repeat(32));
                root.setAttribute('data-nv-snapshot', 'snapshot-0');
                root.setAttribute('data-nv-revision', '0');
                root.setAttribute('data-nv-state', '{"count":0}');
                for (const spec of elements) {
                  const child = document.createElement(spec.tag);
                  for (const [name, value] of spec.attributes)
                    try {
                      child.setAttribute(name, value);
                    } catch {
                      // Invalid attribute names cannot exist in server markup.
                    }
                  if (spec.tag !== 'input') child.textContent = 'x';
                  root.append(child);
                }
                host.append(root);
              });
              const client = createLiveClient({
                root: host,
                fetch: async (url) => {
                  requests.push(new URL(String(url), location.href).href);
                  return new Response('{}', {
                    status: 503,
                    headers: { 'content-type': 'application/json' },
                  });
                },
                onError: (error) => {
                  reported.push(window.nvCode(error));
                },
                confirm: () => Promise.resolve(false),
                maxObservers: 8,
                requestTimeoutMs: 1000,
              });
              let thrown = '';
              try {
                client.mount();
                for (const element of host.querySelectorAll('*')) {
                  element.dispatchEvent(
                    new MouseEvent('click', {
                      bubbles: true,
                      cancelable: true,
                    }),
                  );
                  element.dispatchEvent(
                    new KeyboardEvent('keydown', {
                      key: 'Enter',
                      bubbles: true,
                      cancelable: true,
                    }),
                  );
                  if (element instanceof HTMLInputElement) {
                    element.value = '12';
                    element.dispatchEvent(
                      new Event('input', { bubbles: true }),
                    );
                    element.dispatchEvent(
                      new Event('change', { bubbles: true }),
                    );
                  }
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
              } catch (error) {
                thrown = String(error);
              }
              client.dispose();
              host.remove();
              return {
                thrown,
                requests,
                reported,
                location: location.pathname,
              };
            }, components);
            expect(result.thrown).toBe('');
            expect(result.location).toBe('/');
            for (const url of result.requests)
              expect(url).toMatch(
                new RegExp(
                  `^${base.replace(/\./g, '\\.')}/_live/fuzz/[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`,
                ),
              );
            // Marker JSON is server-rendered; only classified errors surface.
            for (const code of result.reported)
              expect(code).toMatch(/^[A-Z]+$/);
            await expectQuietPage();
          },
        ),
        propertyRuns(25),
      );
    });
  },
  fuzzTimeout,
);
