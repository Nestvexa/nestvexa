import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  PageNotFoundError,
  createPageRegistry,
  createReactPageResolver,
  isPageName,
} from '../packages/react/dist/index.js';
import type { ReactPageModule } from '../packages/react/dist/index.js';
import { createVuePageResolver } from '../packages/vue/dist/index.js';
import type { VuePageModule } from '../packages/vue/dist/index.js';
import { createSveltePageResolver } from '../packages/svelte/dist/index.js';
import type { SveltePageModule } from '../packages/svelte/dist/index.js';
import { loadSsrBundle, pageObject } from './frontend-support.js';
import type { Example } from './frontend-support.js';
import { propertyRuns } from './support/property-runs.js';

/**
 * Property-based fuzzing of the React, Vue and Svelte Inertia adapters
 * (SEC-004): the page props each official SSR bundle renders and the
 * hydration payload (`<script data-page type="application/json">`) it hands
 * to the browser client, and the page registry and resolvers that turn a
 * server-supplied component name into code. Invariants: no crash, no
 * prototype pollution, hostile strings never become markup or script, the
 * hydration payload round-trips the props exactly, and only registered
 * page names resolve.
 */
vi.setConfig({ testTimeout: 120_000 });
const runs = propertyRuns(60);
const nameRuns = propertyRuns(300);

const hostile = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom(
    '</script><script>globalThis.__pwned=1</script>',
    '</SCRIPT><img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    '<!--<script>',
    '  ',
    '{{constructor.constructor("alert(1)")()}}',
    '{@html "<img src=x onerror=alert(1)>"}',
    'javascript:alert(1)',
    '&lt;already&gt;',
  ),
);
const key = fc.oneof(
  fc.stringMatching(/^[a-z][A-Za-z0-9]{0,8}$/),
  fc.constantFrom(
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    '</script>',
  ),
);
/** JSON data with own `__proto__`-style keys, as a server could send. */
const data = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    hostile,
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 3 }),
    tie('object'),
  ),
  object: fc
    .array(fc.tuple(key, tie('value')), { maxLength: 4 })
    .map((entries) => {
      const object: Record<string, unknown> = {};
      for (const [name, value] of entries)
        Object.defineProperty(object, name, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return object;
    }),
})).object;
const homeProps = fc.record({
  greeting: hostile,
  renderedBy: hostile,
  visits: fc.integer({ min: 0, max: 1_000_000 }),
  extra: hostile,
  data,
});

const polluted = () =>
  ['polluted', 'isAdmin', '__pwned'].some(
    (name) => Reflect.get(Object.prototype, name) !== undefined,
  ) || Reflect.get(globalThis, '__pwned') !== undefined;

/** Splits SSR output into the hydration payload and the rendered markup. */
function inspect(body: string) {
  const match =
    /^<script data-page="app" type="application\/json">(.*?)<\/script>/is.exec(
      body,
    );
  expect(match, body.slice(0, 200)).not.toBeNull();
  const payload = match?.[1] ?? '';
  const markup = body.slice(match?.[0].length ?? 0);
  return { payload, markup };
}

describe.each([
  'inertia-react',
  'inertia-vue',
  'inertia-svelte',
] as const satisfies readonly Example[])('%s SSR page props', (example) => {
  it('renders hostile props as escaped text and round-trips them in the hydration payload', async () => {
    const { render } = await loadSsrBundle(example);
    await fc.assert(
      fc.asyncProperty(homeProps, async (props) => {
        const page = pageObject('Home', props);
        const result = await render(page);
        const { payload, markup } = inspect(result.body);
        // The payload is inert JSON that cannot end its script element early.
        expect(payload.toLowerCase()).not.toContain('</script');
        expect(payload).not.toContain('<!--');
        const parsed: unknown = JSON.parse(payload);
        expect(Reflect.get(Object(parsed), 'component')).toBe('Home');
        expect(Reflect.get(Object(parsed), 'props')).toEqual(
          JSON.parse(JSON.stringify(page.props)),
        );
        // The markup holds no element a hostile string could have created.
        expect(markup).toMatch(/^<div data-server-rendered="true" id="app">/);
        expect(markup).not.toMatch(/<(?:script|img|svg|iframe|object)\b/i);
        for (const tag of markup.match(/<[a-z][^>]*>/gi) ?? [])
          expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
        // Same element structure as with harmless strings: every `<` a
        // hostile string carried was escaped, so none opened an element.
        // (Empty strings stay empty: React renders them without a text node.)
        const neutral = (text: string) => (text === '' ? '' : 'x');
        const baseline = inspect(
          (
            await render(
              pageObject('Home', {
                ...props,
                greeting: neutral(props.greeting),
                renderedBy: neutral(props.renderedBy),
                extra: neutral(props.extra),
              }),
            )
          ).body,
        ).markup;
        expect(markup.split('<').length).toBe(baseline.split('<').length);
        for (const head of result.head) expect(head).not.toMatch(/<script\b/i);
        expect(polluted()).toBe(false);
      }),
      runs,
    );
  });

  it('refuses any component name outside its page registry', async () => {
    const { render } = await loadSsrBundle(example);
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 30 }),
          fc.constantFrom(
            '../Home',
            'Home/../../server',
            '__proto__',
            'constructor',
            'toString',
            'hasOwnProperty',
            'Home.tsx',
            'home',
            ' Home',
            'Home\u0000',
          ),
        ),
        async (component) => {
          fc.pre(component !== 'Home' && component !== 'Broken');
          const outcome = await render(pageObject(component)).then(
            () => 'rendered',
            (error: unknown) => (error instanceof Error ? error.name : 'other'),
          );
          // A random name can match a real page (`Users/Index`), which must
          // then render; everything else is PageNotFoundError.
          if (outcome === 'rendered') expect(isPageName(component)).toBe(true);
          else expect(outcome).toBe('PageNotFoundError');
          expect(polluted()).toBe(false);
        },
      ),
      runs,
    );
  });
});

describe('page registry and framework resolvers', () => {
  const module = { default: () => null };
  const registry = <TModule>(page: TModule) =>
    createPageRegistry<TModule>(
      {
        './pages/Home.tsx': async () => page,
        './pages/Users/Index.tsx': async () => page,
      },
      { base: './pages/', extensions: ['.tsx'] },
    );
  const pages = registry<ReactPageModule>(module);
  const resolvers: ((name: string) => Promise<unknown>)[] = [
    createReactPageResolver(pages),
    createVuePageResolver(
      registry<VuePageModule>({
        default: { name: 'Home', render: () => null },
      } as VuePageModule),
    ),
    createSveltePageResolver(
      registry<SveltePageModule>({
        default: (() => ({})) as unknown as SveltePageModule['default'],
      }),
    ),
  ];
  const names = fc.oneof(
    fc.string({ maxLength: 30 }),
    fc.string({ unit: 'binary', maxLength: 30 }),
    fc
      .array(
        fc.constantFrom('Home', 'Users', 'Index', '..', '.', '', '__proto__'),
        { minLength: 1, maxLength: 4 },
      )
      .map((parts) => parts.join('/')),
    fc.anything(),
  );

  it('accepts only safe page names and resolves only registered ones', async () => {
    await fc.assert(
      fc.asyncProperty(names, async (name) => {
        const valid = isPageName(name);
        if (valid) {
          expect(name).toMatch(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
          expect(name).not.toContain('..');
        }
        const registered = name === 'Home' || name === 'Users/Index';
        expect(pages.has(name as string)).toBe(registered);
        for (const resolve of resolvers) {
          const outcome = await resolve(name as string).then(
            (value) => value,
            (error: unknown) => error,
          );
          if (registered) expect(outcome).not.toBeInstanceOf(Error);
          else expect(outcome).toBeInstanceOf(PageNotFoundError);
        }
        expect(polluted()).toBe(false);
      }),
      nameRuns,
    );
  });

  it('rejects registries built from unsafe glob keys', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.oneof(
            fc.string({ maxLength: 20 }).map((tail) => `./pages/${tail}`),
            fc.constantFrom(
              './pages/../secret.tsx',
              './pages/__proto__.tsx',
              './other/Home.tsx',
              './pages/a b.tsx',
            ),
          ),
          fc.constant(async () => module),
          { maxKeys: 4 },
        ),
        (glob) => {
          try {
            const registry = createPageRegistry<
              ReactPageModule | VuePageModule | SveltePageModule
            >(glob, { base: './pages/', extensions: ['.tsx'] });
            for (const name of registry.names)
              expect(isPageName(name)).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).name).toBe('PageRegistryError');
          }
          expect(polluted()).toBe(false);
        },
      ),
      nameRuns,
    );
  });
});
