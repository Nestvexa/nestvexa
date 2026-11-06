---
'@nestvexa/islands': minor
---

Build-time island manifest (`@nestvexa/islands/build`: `createIslandManifest`
from an esbuild-style metafile, `analyzeIslandBundles` for per-island chunk
graphs, framework separation and gzip budgets) consumed by
`IslandRegistry.fromManifest` and by the browser loader (`createIslands({ manifest })`
enforces ids, frameworks, size limits and props schemas and loads manifest
bundle paths). Closed props schemas and secret-like key rejection on render,
HMAC-signed props (`signed: true`, `signingKeys` rotation, expiry,
`verifyProps`), a validated shared page context (`contextScript`: theme tokens
applied as `--nv-*` custom properties, locale, direction, display-only user),
sibling `<noscript>` content, `renderSsr` with `@nestvexa/islands/react-server`,
`/vue-server` and `/svelte-server` renderers, hydration in the Vue and Svelte
adapters (React already hydrated) with mismatch reporting
(`onHydrationMismatch`, `data-nv-hydration-mismatch`), typed `services`,
event payload predicates, early listener removal, loader `diagnostics()`, and
cleanup on `pagehide`.
