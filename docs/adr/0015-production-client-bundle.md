# 0015 — Canonical production Live bundle

Status: accepted for the current experimental implementation.

The growing Phase 4 runtime exceeded the original 35 KiB budget when each emitted
ES module was gzipped separately. Keep the same budget and ship one minified ESM
entry instead. The browser still uses original, independently testable TypeScript
modules during development of the library; applications import the single public
entry. This preserves one component ownership registry and one public error class.

TypeScript checks types and emits documented declarations. esbuild 0.28.2 bundles
and minifies the browser entry, retaining exported names, legal comments, and a
linked source map with original TypeScript sources. No property mangling, dynamic
evaluation, runtime build service, or frontend framework dependency is introduced.
See [esbuild's build API](https://esbuild.github.io/api/#build) and
[minification contract](https://esbuild.github.io/api/#minify).

Rejected alternatives: increasing the budget hides a regression; excluding new
reachable features from the measurement understates cost; maintaining a second
public unbundled entry would create independent ownership registries and duplicate
mount hazards. Splitting optional features may be useful later, but needs a tested
installation and lifecycle contract first.

Private per-module JavaScript outputs exist solely for implementation tests. The
package files allowlist excludes those JavaScript files. All referenced declaration
files remain included. The default asset catalog serves the canonical entry,
Alpine, and the Alpine adapter. Source maps are packaged for debugging but are not
served by the default public asset route. Hosts choose whether to expose sources.

`scripts/size.mjs` measures all custom code reachable from the canonical entry as
one gzip estimate. It excludes Alpine, the Alpine adapter, maps and HTTP framing;
the example does not automatically enable HTTP compression. This metric is neither
total startup traffic nor a latency benchmark. Packed-consumer and browser tests
exercise the same public entry. `tests/assets.test.ts` checks the served entry has
no remaining static or dynamic module dependencies; `tests/contracts.test.ts`
checks declarations and source maps. The tarball inspection and actual external
consumption checks remain required after this build change.

Failure modes: missed bundle code can break directives; minification can expose
assumptions about local function names; publicly served maps may reveal sources.
Run aggregate, three-browser, CSP, packed-consumer and size gates before accepting
the checkpoint. No supported public export has changed; private file imports are
not an extension API.

## Amendment (2026-11-07)

The canonical entry remains the only public entry and ownership registry.
[ADR 0035](0035-client-feature-chunks.md) adds four fixed-name feature chunks
that the entry imports on demand and that import the entry's error class back;
the asset catalog serves them beside it.
