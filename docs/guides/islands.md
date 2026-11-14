# Islands and hybrid pages

Allowlisted React, Vue and Svelte **islands** inside Nestvexa HBS and Live pages, with
explicit DOM ownership: the framework owns its island root, Live and Alpine never
patch inside it, and Live morphs retain island roots. Optional; not part of the
default `nestvexa` install. This guide walks through the
[hybrid dashboard example](../../examples/hybrid-dashboard); the full reference
is the [package README](../../packages/islands/README.md).

## Install

```sh
npm install @nestvexa/islands
# plus the frameworks you use (optional peers)
npm install react react-dom   # and/or vue, svelte
```

Node 22.13+ or 24 on the server. Browser bundles are built with your bundler:
the hybrid dashboard uses esbuild with code splitting, and
[examples/islands-vite](../../examples/islands-vite) builds the same contract
through Vite and `@nestvexa/vite` ([Building islands with Vite](#building-islands-with-vite)).

## 1. Define islands and build the manifest

Each island is an entry module whose default export is an adapter mount
function (`export default reactIsland(Chart)`, `vueIsland(Feed)`,
`svelteIsland(Widget)`). List them once, with id, framework, strategy, entry,
props schema and gzip budget, and let the build write the manifest:

```js
const result = await build({
  entryPoints,
  splitting: true,
  metafile: true,
  outdir: 'dist/public/islands' /* ... */,
});
const manifest = createIslandManifest(definitions, result.metafile, {
  outdir: 'dist/public/islands',
  publicPath: '/islands/',
});
const analysis = analyzeIslandBundles(manifest, result.metafile, {
  outdir: 'dist/public/islands',
  publicPath: '/islands/',
});
```

`examples/hybrid-dashboard/build-client.mjs` writes the manifest twice (for the
server and for the loader bundle), the analysis (chunk list per framework) and
the raw metafile, and fails the build on a violation: a foreign framework
runtime in an island's chunk graph or an island over its budget.

### Building islands with Vite

`islandsVitePlugin` (from `@nestvexa/islands/build`) is the Vite alternative to
the esbuild script. Give the island entries to Vite as inputs and the plugin
the definitions:

```ts
// vite.islands.config.ts
import { islandsVitePlugin } from '@nestvexa/islands/build';
import { islandDefinitions } from './src/island-definitions.js';

export default defineConfig(({ isSsrBuild }) => ({
  base: '/islands/',
  plugins: [
    react(),
    svelte(),
    islandsVitePlugin({ islands: islandDefinitions }),
  ],
  build: isSsrBuild
    ? { outDir: 'dist/ssr', emptyOutDir: true }
    : {
        outDir: 'dist/islands',
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: { input: islandDefinitions.map((i) => i.entry) },
      },
}));
```

- `vite build -c vite.islands.config.ts`: the plugin records an esbuild-style
  metafile of the client output (static `imports` form an island's chunk
  closure, `dynamicImports` are lazy and not counted against the budget,
  bundled module ids reveal framework runtimes), then writes
  `islands-manifest.json`, `islands-analysis.json` and `islands-metafile.json`
  into `dist/islands/.vite/` (dot directories are never served by
  `viteStaticMiddleware`) and fails the build on a violation. It also sets
  `build.rolldownOptions.preserveEntrySignatures: 'exports-only'`, because Vite
  app builds otherwise drop the entries' `default` mount export, and fails if
  an island entry lost it anyway.
- `vite build -c vite.islands.config.ts --ssr client/ssr.ts`: a Node module
  exporting `renderers`. The server wraps it with
  `moduleIslandRenderers(ids, () => import(ssrUrl))` (loaded once, a failed
  load is retried, a missing renderer falls back).
- The loader is a second, later Vite build that imports the generated
  manifest (`createIslands({ manifest })`), so islands load only from their
  manifest bundle paths; its own `.vite/manifest.json` drives the nonce'd
  tags printed by `ViteAssets.tags('islands', { nonce })`.
- Development: `createViteDevServer({ root, configFile, hmrServer })` with the
  same config. The registry is built from the definitions
  (`new IslandRegistry(islandDefinitions, …)`), SSR uses
  `moduleIslandRenderers(ids, () => vite.server.ssrLoadModule('/client/ssr.ts'), { cache: false })`,
  and a development loader allowlists the islands with a static
  `modules` map of dynamic imports (there is no build manifest yet, so props
  schemas are enforced by the server registry only).

Only a Vite build manifest is needed for the island manifest itself:
`createViteIslandManifest(definitions, viteManifest, { base })` maps each
entry's `file` to its bundle path (use the plugin when you also want the
analysis). Verified with Vite 8.3.5 (Rolldown option names).

## 2. Register on the server, render and server-render

```ts
const islands = IslandRegistry.fromManifest(manifest, {
  signingKeys: [secret],
  renderers, // from a Node SSR bundle: reactIslandRenderer, vueIslandRenderer, svelteIslandRenderer
});
return {
  chart: islands.render('revenue-chart', props, {
    key: 'chart',
    fallback: 'Loading chart…',
  }),
  feed: await islands.renderSsr(
    'activity-feed',
    { items },
    { noscript: 'Needs JavaScript.' },
  ),
  islandContext: islands.contextScript({
    locale: 'en',
    theme: { accent: '#2f5bff' },
  }),
};
```

Server rendering emits the component HTML plus `data-nv-ssr`; the adapter then
hydrates instead of mounting. Without JavaScript, visitors see the SSR HTML (or
the fallback) and the sibling `<noscript>` content. Live `@Computed` values are
synchronous, so islands owned by a Live component use `render()`.

## 3. Start the loader

```ts
createIslands<DashboardServices>({
  manifest: parseIslandManifest(manifestJson),
  services: { actions: createActions(createActionsClient()) },
  onHydrationMismatch: (element, mismatch) => report(mismatch),
}).start();
```

The manifest is bundled into the loader, so page markup can never choose code:
unknown ids, framework mismatches, oversized or schema-violating props are
refused with `data-nv-island-error` and nothing is imported. Each island loads
from its manifest bundle path as a separate chunk graph; React, Vue and Svelte
runtimes stay in their own shared chunks.

## 4. Call typed server actions from islands

Generate framework bindings with `@nestvexa/actions` (`targets: ['react', 'vue', 'svelte']`)
and pass the typed actions client as a loader service:

```tsx
// React island
const hooks = useMemo(
  () => createActionHooks(island.services.actions),
  [island],
);
const record = hooks.useDashboardRecordEvent();
record.run({ kind: 'chart.selected', label: 'Quarter 1' });
```

The Vue feed uses `createActionComposables(...).useDashboardRecordEvent()` and
shows typed validation issues (`state.error.issues[0].path[0] === 'label'`); the
Svelte widget uses `createActionStores(...).dashboardSetStatus()` as `$status`.
Tenant and permission checks happen on the server in the action's host policy
and guards; islands only hold public data.

## 5. Signed props

Mark an island `signed: true` and configure `signingKeys`. The rendered root
carries a token over the exact props JSON. The island sends `island.signed`
(`{ props, token }`) with its action, and the server verifies it:

```ts
const props = islands.verifyProps('status-widget', input.props, input.token); // IslandError if tampered or expired
```

## 6. Theme, locale and shared context

`contextScript` validates and serializes the page context into a JSON script in
`<head>`. The loader exposes it as `island.shared` and applies theme tokens as
`--nv-<name>` CSS custom properties on each island root, so components style
with `var(--nv-accent)`. Only display data belongs here.

[examples/showcase](../../examples/showcase) puts the negotiated `locale` and
`direction` in the context, passes every visible string already translated in
the props (so SSR and hydration agree in English and Arabic), and builds Vue,
React (the `@nestvexa/ui` chart wrapper) and Svelte islands as lazy chunks of
one Vite loader under a strict CSP without `'unsafe-inline'`
([tests/browser/showcase-islands.spec.ts](../../tests/browser/showcase-islands.spec.ts)).

## 7. Diagnostics, events and lifecycle

- `loader.diagnostics()` shows each island's state, listener count, rejected
  events and hydration outcome (`hydrated` / `mismatch`).
- `island.on(name, handler, accept)` validates event payloads; listeners are
  capped per island and removed on unmount.
- Live updates keep islands mounted; removing markup unmounts; `nv:navigate`
  body swaps clean up the old page's islands (an island removed while its chunk
  is still loading never mounts); full navigations run cleanup on `pagehide`.
- The `/hybrid/diagnostics` page renders deliberately mismatching React, Vue
  and Svelte islands to show mismatch reporting.

## Security

Islands are trusted application code chosen at build time. Props and the page
context are public data: the registry rejects secret-like keys and undeclared
schema fields, but never pass entities or secrets. Server-rendered fallback HTML
must be trusted (`SafeHtml`) or plain text (escaped). Signed props prove origin,
not permission.

## Testing and budgets

```sh
pnpm build
pnpm vitest run tests/islands.test.ts tests/islands-client.test.ts tests/islands-bundle.test.ts tests/islands-vite.test.ts
pnpm size:islands
pnpm exec playwright test tests/browser/islands.spec.ts tests/browser/islands-deferral.spec.ts tests/browser/islands-vite.spec.ts
```

`tests/islands-vite.test.ts` drives the Vite plugin hooks (metafile, manifest,
analysis, foreign runtime and lost default export failures, SSR builds
ignored), `createViteIslandManifest` (unsafe bases and files rejected),
`moduleIslandRenderers`, and the `examples/islands-vite` build output.
`tests/browser/islands-vite.spec.ts` checks the production build (SSR markup
from the Vite SSR bundle, nonce'd loader, clean hydration of all three
frameworks with no CSP violations, only manifest bundle paths loaded, tampered
props refused by the bundled schema, `.vite` metadata not served) and the dev
middleware (SSR through `ssrLoadModule`, clean hydration).

The browser spec covers independent mounts, retention across Live updates,
removal and reinsertion, typed actions from all three frameworks (including a
job action and tampered signed props), clean hydration with theme tokens,
per-framework mismatch reporting, no-JavaScript output, navigation cleanup with
an in-flight chunk, error fallback and axe checks. Package:
[@nestvexa/islands](../../packages/islands/README.md).

## CLI

`nestvexa add islands` generates the server registry, the client allowlist, `vite.islands.config.ts` and static serving; `nestvexa make:island <Name> --renderer react|vue|svelte` adds the component and both registry entries. See the [CLI reference](../reference/cli.md).
