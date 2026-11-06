# Hybrid dashboard example

One HBS page combining a Live component with React, Vue and Svelte islands
(`@nestvexa/islands`) that call typed server actions (`@nestvexa/actions`).

- [`build-client.mjs`](build-client.mjs): builds every island as its own
  code-split entry, writes `islands-manifest.json` (allowlist, bundle paths,
  props schemas, budgets) and `islands-analysis.json` (chunks per framework)
  from the esbuild metafile, bundles the loader with the manifest, and builds a
  Node SSR bundle with the React, Vue and Svelte renderers.
- [`scripts/codegen.mjs`](scripts/codegen.mjs): generates the typed actions
  client plus React hooks, Vue composables and Svelte stores into
  `client/generated/` (git-ignored).
- [`src/main.ts`](src/main.ts): `IslandRegistry.fromManifest` with signing keys
  and SSR renderers, the page context (theme tokens, locale, display user), a
  Live component owning the React chart, server-rendered KPI (React), feed (Vue)
  and status widget (Svelte), `/hybrid/about` for `nv:navigate`, and
  `/hybrid/diagnostics` with deliberate hydration mismatches.
- [`src/dashboard.ts`](src/dashboard.ts): the `dashboard` action group:
  `record-event`, `set-status` (verifies the widget's signed props) and
  `export-report` (job action on `@nestvexa/realtime`'s `JobRunner`, polled with
  progress). Spans are recorded with `@nestvexa/observability`'s
  `MemoryInstrumentation` (`GET /api/action-spans`).

```sh
pnpm build
pnpm --filter @nestvexa/example-hybrid-dashboard start
# open http://127.0.0.1:3112/hybrid (PORT overrides the port)
pnpm size:islands   # per-island gzip budgets
```

Browser coverage: [tests/browser/islands.spec.ts](../../tests/browser/islands.spec.ts).
This is a local demonstration: guest sessions, a random signing key per process
and in-memory job storage.
