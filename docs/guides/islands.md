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

Node 22.13+ or 24 on the server. Browser bundles are built with your bundler (the
example uses esbuild with code splitting).

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
pnpm vitest run tests/islands.test.ts tests/islands-client.test.ts tests/islands-bundle.test.ts
pnpm size:islands
pnpm exec playwright test tests/browser/islands.spec.ts
```

The browser spec covers independent mounts, retention across Live updates,
removal and reinsertion, typed actions from all three frameworks (including a
job action and tampered signed props), clean hydration with theme tokens,
per-framework mismatch reporting, no-JavaScript output, navigation cleanup with
an in-flight chunk, error fallback and axe checks. Package:
[@nestvexa/islands](../../packages/islands/README.md).
