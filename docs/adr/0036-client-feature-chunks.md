# 0036 — On-demand Live client feature chunks

Status: accepted 2026-11-07 for the current experimental implementation.
Amends [ADR 0015](0015-production-client-bundle.md) (one canonical entry) and
[ADR 0020](0020-client-budget-revision.md) (one 48 KiB gate), which deferred
code splitting until an installation, CSP and ownership contract existed.

## Context

The specification requires a minimal footprint and code splitting for the
browser runtime (BROW-004). Every Live page downloaded the whole runtime,
including features most pages never use. After touch, grid and connected-list
sorting (DIR-017) the single bundle measured 151,242 minified / 50,196 gzip
bytes: over the 48 KiB gate. Measured by feature module, four optional features
are large, self-contained and only reachable from specific markup or options:

| Feature  | Reachable from                                     |
| -------- | -------------------------------------------------- |
| sort     | `nv:sort*` markup                                  |
| stream   | `nv:stream` markup or `startStream()`              |
| upload   | `nv:upload*` markup or `upload()`                  |
| realtime | a `realtime` option **and** a subscribed component |

Everything else (protocol, morphing, models, events, loading, navigation,
optimistic updates, `inspect()` for devtools) is either used by most pages or
too small and entangled with the ownership registry to split profitably.
`inspect()` is a short read-only walk of the registry it would have to share;
the devtools panel itself is a separate package that loads only in development.

## Decision

1. **Chunks.** `scripts/build-client.mjs` bundles `packages/client/dist/index.js`
   plus four sibling chunks: `live-sort.js`, `live-stream.js`, `live-upload.js`
   and `live-realtime.js`. The entry imports each with a literal
   `import('./live-<feature>.js')`; a chunk's only import is
   `import { LiveClientError, parseIdentifier } from './index.js'`, so the page
   keeps one error class and one ownership registry. The build fails on any
   other cross-module import from a chunk.
2. **Serving.** `nestvexa/assets` serves the chunks in the same
   content-addressed catalog version as the entry
   (`/_nestvexa/assets/<sha256>/live-sort.js`), immutable, with ETags. Relative
   specifiers therefore always resolve to the matching version; no version skew
   between entry and chunk is possible. The canonical `boot.js` is unchanged.
3. **Loading.** The entry keeps the small parsers and option copies of every
   feature. Discovery scans a marker's subtree for `nv:sort`, `nv:stream` and
   `nv:upload` attributes; a marker that needs an unloaded chunk stays
   unregistered and inert (exactly like server HTML before boot) until the chunk
   arrives, then the next discovery validates and registers it with the full
   validator. A server response whose HTML names an unloaded feature awaits the
   chunk before morphing, so it is validated as if every chunk were present.
   Explicit `startStream()` / `upload()` calls load their chunk. The realtime
   chunk loads only when a realtime endpoint is configured and a mounted
   component carries a realtime token; endpoint validation still fails at
   `mount()`. Each chunk is requested at most once per page and shared by all
   clients; a failed load reports `LiveClientError('NETWORK')`, rejects the
   waiting marker and lets a later discovery retry.
4. **CSP and SRI.** Loading uses only standard module `import()`: no `eval`,
   `Function`, inline script, `blob:` URL or injected `<script>`. Per the HTML
   specification the dynamic import inherits the importing module's nonce, so
   a nonce-only `script-src` (no `'self'`, no `'strict-dynamic'`) works, as do
   `'self'` and `'strict-dynamic'` policies and Trusted Types (no sink is used).
   The asset manifest now carries a SHA-384 `integrity` digest per served file.
   `browser.importMap(nonce?)` renders an inline import map whose `integrity`
   section pins the entry, every chunk, Alpine and its adapter; `nvScripts`
   accepts `integrity=true` to emit it before the boot tag. A tampered chunk is
   then refused by the browser.
5. **Budgets.** `scripts/size.mjs` gates each file and the worst case, gzip
   level 9, maps excluded, and fails if the entry imports an unbudgeted chunk:

| File               | Budget (gzip) | Measured 2026-11-07 |
| ------------------ | ------------- | ------------------- |
| `index.js` (core)  | 44 KiB        | 38,759              |
| `live-sort.js`     | 6 KiB         | 5,415               |
| `live-stream.js`   | 4.5 KiB       | 3,497               |
| `live-upload.js`   | 5 KiB         | 4,053               |
| `live-realtime.js` | 3 KiB         | 2,024               |
| all files          | 60 KiB        | 53,748              |

The 48 KiB single-bundle gate of ADR 0020 is replaced by these gates. A page
without optional features now transfers 38,759 gzip bytes of Live code instead
of 50,196 (−23 %). A page using every feature transfers 3,552 bytes more than one
bundle would (separate gzip dictionaries and the per-chunk import line).

## Rejected alternatives

- **esbuild `splitting: true`.** Produces hashed shared chunks whose names and
  number change with the code; the asset catalog, package `files` allowlist and
  budgets would need to follow build output. Fixed names keep the catalog and
  CSP review static.
- **Splitting more (models, navigation, events, optimistic).** Used by most
  pages; splitting would delay first interaction for the common case.
- **Loading every chunk eagerly or by `modulepreload`.** Defeats the footprint
  goal. Hosts may add `<link rel="modulepreload">` for a chunk they know a
  page needs.
- **`integrity` attributes on injected `<script>` tags.** Needs DOM script
  injection (a Trusted Types sink) and does not cover static/dynamic imports.

## Consequences and failure modes

- A page using `nv:sort`, `nv:stream` or `nv:upload` registers that component
  one network round trip after boot (cached afterwards). Tests and hosts that
  read handle state immediately after boot must wait for registration.
- A host that serves only `index.js` (for example a custom static copy) breaks
  optional features with a `NETWORK` error: serve every file in
  `CLIENT_MODULES`.
- Bundlers consuming `@nestvexa/client` see the literal dynamic imports and emit
  their own chunks (verified with the Vite build of `examples/inertia-mixed`).
- Import-map integrity is opt-in. Browsers without import-map `integrity`
  support ignore the section; the content-addressed URL and CSP still apply.

Evidence: `tests/assets.test.ts` (catalog, sibling imports, one error identity,
SRI digests of served bytes), `tests/browser/client-chunks.spec.ts` (Chromium,
Firefox and WebKit: no chunk on core pages, one chunk on use, nonce-only CSP,
Trusted Types with `nv:navigate`, refused tampered chunk, upload/realtime/stream
chunks on their pages), `pnpm size:check`.
