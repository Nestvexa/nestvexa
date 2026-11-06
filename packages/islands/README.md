# @nestvexa/islands

Allowlisted React, Vue and Svelte **islands** inside Nestvexa HBS and Live pages, with
explicit DOM ownership: the framework owns its island root, Live and Alpine never
patch inside it, and Live morphs retain island roots. Optional; not part of the
default `nestvexa` install.

## Install

```sh
npm install @nestvexa/islands
# plus the frameworks you use (optional peers)
npm install react react-dom   # and/or vue, svelte
```

Node 22.13+ or 24 on the server. Browser bundles are built with your bundler (the
example uses esbuild with code splitting).

| Entry                                                       | Runs in | Purpose                                              |
| ----------------------------------------------------------- | ------- | ---------------------------------------------------- |
| `@nestvexa/islands`                                         | server  | `IslandRegistry`, markup, SSR, signing, page context |
| `@nestvexa/islands/build`                                   | build   | manifest from a bundler metafile, bundle analysis    |
| `@nestvexa/islands/client`                                  | browser | loader (`createIslands`)                             |
| `@nestvexa/islands/react\|vue\|svelte`                      | browser | framework adapters (mount or hydrate)                |
| `@nestvexa/islands/react-server\|vue-server\|svelte-server` | server  | SSR renderers                                        |

## Build-time manifest

The manifest is the single allowlist for server and browser: id, framework,
mount strategy, bundle path, props size limit, closed props schema, signing and
a gzip budget.

```js
import { build } from 'esbuild';
import {
  analyzeIslandBundles,
  createIslandManifest,
} from '@nestvexa/islands/build';

const definitions = [
  {
    id: 'revenue-chart',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/react-chart.tsx',
    budgetBytes: 80_000,
    props: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 80 },
        values: { type: 'array', maxItems: 12, items: { type: 'number' } },
      },
      required: ['title', 'values'],
    },
  },
];
const result = await build({
  entryPoints: definitions.map((d) => d.entry),
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: 'dist/public/islands',
  outbase: 'client',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunks/[name]-[hash]',
  metafile: true,
});
const options = { outdir: 'dist/public/islands', publicPath: '/islands/' };
const manifest = createIslandManifest(definitions, result.metafile, options);
const report = analyzeIslandBundles(manifest, result.metafile, options);
// report.islands[n].chunks / gzipBytes / withinBudget, report.frameworks,
// report.violations (foreign framework runtime in a closure, or over budget)
```

Bundle paths must be same-origin absolute module paths (`/islands/x-HASH.js`);
scheme-relative, absolute, `..` and non-`.js` paths are rejected. Props schemas
are a closed JSON-schema subset (`string` with `maxLength`/`enum`, `number`,
`integer` with bounds, `boolean`, `null`, `array` with `items`/`maxItems`,
`object` with `properties`/`required`, `anyOf`); objects never accept undeclared
keys.

## Server: registry and markup

```ts
import { IslandRegistry } from '@nestvexa/islands';

export const islands = IslandRegistry.fromManifest(manifestJson, {
  signingKeys: [process.env.ISLAND_KEY], // >= 32 bytes; first signs, all verify
  renderers: { 'activity-feed': vueIslandRenderer(ActivityFeed) },
});
// or: new IslandRegistry([{ id, framework, strategy?, maxPropsBytes?, props?, signed? }], options)

islands.render(
  'revenue-chart',
  { title: 'Revenue', values: [12, 19] },
  {
    key: 'chart', // stable Live morph key
    label: 'Revenue chart', // role="region" + aria-label
    fallback: 'Loading chart…', // text, or trusted SafeHtml
    noscript: 'Charts need JavaScript.', // sibling <noscript>
  },
);
await islands.renderSsr(
  'activity-feed',
  { items },
  { context: { locale: 'en' } },
);
islands.contextScript({
  locale: 'en',
  direction: 'ltr',
  theme: { accent: '#2f5bff' },
  user: { name: 'Ada' },
});
islands.verifyProps('status-widget', propsJson, token); // throws IslandError when tampered/expired
islands.preload(['revenue-chart']); // <link rel="modulepreload"> for manifest bundles
```

- **Props** are plain JSON (no functions, dates, BigInt, cycles or prototype
  keys), bounded (default 32 KiB, max 256 KiB), validated against the island's
  schema and HTML-escaped into `data-nv-props`. Keys that look like secrets
  (`password`, `token`, `apiKey`, `session`, `cookie`, `csrf`, `secret`,
  `credential`, `authorization`, `privateKey`) are rejected unless the definition
  sets `allowSensitiveKeys`. Unknown ids throw. Props are public page data.
- **Signed props** (`signed: true`): `data-nv-props-token="v1.<iat>.<exp>.<hmac>"`
  binds the island id, the exact props JSON and an expiry (`signatureTtlMs`,
  default 1 hour). Islands send `context.signed` back (for example in a server
  action) and the server calls `verifyProps`, which rejects changed props,
  another island's token, a forged or expired token. A valid signature proves
  origin, not current permission: authorize again.
- **SSR**: `renderSsr` runs the registered renderer (React `renderToString`,
  Vue `vue/server-renderer`, Svelte `svelte/server`), marks the root
  `data-nv-ssr` and keeps the same props in `data-nv-props` as hydration state.
  If a renderer throws, `onRenderError` is called and the island degrades to its
  fallback markup. Renderers receive an inert `island` context (`hydrate: true`,
  no-op `on`/`emit`, `services` from the renderer options so hooks and stores
  can be created during render).
- **Page context**: `contextScript` renders `<script type="application/json" id="nv-islands-context">`
  with validated content only: BCP 47-like `locale`, `direction`, design tokens
  (`[a-z][a-z0-9-]*` names; values without `; { } < > \ quotes`) and display-only
  user fields (primitives, no secret-like keys). JSON is `<`/`>`/`&` escaped and
  never executes, so CSP is unaffected. Never use it for authorization input.
- `registry.helpers()` returns an `nvIsland` template helper
  (`{{nvIsland "activity-feed" key="feed" noscript="..." items=items}}`).

## Browser: loader and adapters

```ts
import { createIslands, parseIslandManifest } from '@nestvexa/islands/client';
import manifestJson from './generated/islands-manifest.json';

createIslands({
  manifest: parseIslandManifest(manifestJson), // bundled, never read from the page
  services: { actions }, // typed: createIslands<Services>(...)
  onError: (error, element) => report(error),
  onHydrationMismatch: (element, { id, framework, detail }) => report(detail),
}).start();
// or a static map of bundler-resolved imports:
createIslands({
  modules: {
    'revenue-chart': () => import('./react-chart.js').then((m) => m.default),
  },
});
```

```ts
import { reactIsland } from '@nestvexa/islands/react'; // export default reactIsland(Chart)
import { vueIsland } from '@nestvexa/islands/vue';
import { svelteIsland } from '@nestvexa/islands/svelte';
```

- **Allowlist:** an id must be in `modules` and/or the manifest (every
  configured source); otherwise the root gets `data-nv-island-error` and nothing
  is imported. With a manifest, the markup framework must match, props must fit
  the manifest byte limit and schema, and the module is imported from the
  manifest `bundle` path only (markup attributes are never used as URLs).
- **Strategies:** `immediate`, `visible` (IntersectionObserver), `idle`
  (`requestIdleCallback`, timeout fallback), `interaction` (pointerdown, focus,
  keydown or hover; mounts once).
- **Context** (`island` prop): `id`, `signal` (aborted on unmount), `shared`
  (page context), `services`, `hydrate`, `signed`, `reportMismatch(detail)`,
  `emit(name, detail)`, `on(name, handler, accept?)` → remover.
- **Theme:** tokens become `--nv-<name>` custom properties on each island root;
  `direction`/`locale` set `dir`/`lang` when absent.
- **Hydration:** roots with `data-nv-ssr` hydrate (React `hydrateRoot`, Vue
  `createSSRApp`, Svelte `hydrate`). Mismatches are reported through
  `onHydrationMismatch` (at most 10 per island) and `data-nv-hydration-mismatch`:
  React via `onRecoverableError`; Vue and Svelte by comparing the markup before
  and after the synchronous hydration pass (both frameworks repair text and
  structure in place). Vue attribute-only mismatches are not repaired in
  production builds and therefore not reported.
- **Lifecycle:** a MutationObserver unmounts removed islands (aborting
  `signal`, removing listeners) and mounts inserted ones exactly once. An island
  removed while its chunk is loading never mounts; one removed during an
  asynchronous mount is unmounted as soon as the mount resolves. `pagehide`
  (non-bfcache) runs every island's cleanup; bfcache restores rescan. Nested
  islands are ignored. `aria-busy` is set while loading.
- **Errors:** a failing loader or mount marks the root `data-nv-island-error` and
  keeps the fallback; other islands are unaffected.
- **Event bridge:** namespaced `island:<name>` document events, names
  `[a-z][a-z0-9:.-]{0,63}`, details cloned with `structuredClone` (non-cloneable
  details throw), optional `accept(detail)` predicate (rejections are counted),
  at most `maxListeners` (default 32) per island, removed on unmount.
- **Diagnostics:** `loader.diagnostics()` lists `{ id, element, state, listeners, rejectedEvents, hydration, mountMs }`;
  `loader.mounted` counts mounted islands.

## Live interplay

Live morphs treat `data-nv-island` roots as ownership boundaries: a parent Live
re-render keeps the island DOM and framework state. Removing the island markup in a
Live render unmounts it; re-adding mounts a fresh instance. Live `nv:navigate`
body swaps unmount the old page's islands and mount the new page's. Put the
context script and loader in `<head>` (identical across pages) so swaps are
allowed. Every island interaction that changes server data must go through an
authorized Live action, a Nestvexa action or your own guarded route.

## Performance budgets

`analyzeIslandBundles` reports each island's chunk closure and gzip size;
`pnpm size:islands` (`scripts/islands-size.mjs`) applies the manifest budgets to
the hybrid dashboard build and writes `artifacts/reports/islands-size.json`.

## Security

Islands are trusted application code chosen at build time. Props and the page
context are public data: never put secrets in them (the registry rejects
secret-like keys and undeclared schema fields). Server-rendered fallback HTML
must be trusted (`SafeHtml`) or plain text (escaped). SSR output is framework
generated. Tenant and permission checks stay server-side; signed props prove
origin only.

## Testing

```sh
pnpm build
pnpm vitest run tests/islands.test.ts tests/islands-client.test.ts tests/islands-bundle.test.ts
pnpm exec playwright test tests/browser/islands.spec.ts
```

`islands.test.ts` covers the registry, schemas, secret keys, signing (tamper,
foreign island, expiry, rotation), context escaping, noscript, SSR fallback and
manifests; `islands-client.test.ts` (real Chromium) covers strategies including
`interaction`, allowlist and manifest refusal, the event bridge (cap, names,
cloning, predicates, cleanup), unmount races, `pagehide`, hydration reporting,
theme and services; `islands-bundle.test.ts` asserts framework separation,
budgets and SSR from the example build. The
[hybrid dashboard example](../../examples/hybrid-dashboard/src/main.ts) renders a
Live component owning a React island next to server-rendered React, Vue and
Svelte islands that hydrate and call typed server actions; its browser spec
covers Live retention, removal and reinsertion, typed actions, signed props,
clean and mismatched hydration, no-JS output, navigation cleanup, the unmount
race and axe checks. License: MIT.
