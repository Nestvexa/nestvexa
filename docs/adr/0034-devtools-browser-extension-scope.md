# ADR 0034: In-app devtools panel; browser extension out of scope for v1

Date: 2026-11-06. Status: **accepted** (`@nestvexa/observability`
`DevtoolsModule`, `DevtoolsInspector`; the browser extension is not shipped).

## Context

Section 19.3 of the specification asks for a development panel (registered
components, redacted public state, action timings, lifecycle hooks, renderer
types, CSRF/auth errors, request ids, job progress, re-render causes) and calls
a browser extension optional: "if listed as a deliverable, provide real
build/install docs, stable communication schema, safety gate disabled in prod,
and functional tests". Nestvexa did not list an extension as a v1 deliverable,
but the ledger (DX-034) needs an explicit decision.

An extension would need: a content script and devtools page per browser
(Chromium Manifest V3, Firefox, Safari's separate Xcode wrapper), its own build
and signing, store listings that require publisher accounts the project does
not hold, and a channel to the application that must stay closed in
production. Everything it could show already exists server-side, where the
data is produced.

## Decision

1. **The development panel is part of the application.** `DevtoolsModule`
   serves an HTML page, a stylesheet and `data.json` under
   `/_nestvexa/devtools` (configurable). It is rendered on the server, runs no
   script and is served with `Content-Security-Policy: default-src 'none';
style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors
'none'`. Data comes from `MemoryInstrumentation` (spans from Live, actions,
   uploads, Inertia, SSR, realtime, assets, jobs, guards and requests) and from
   `DevtoolsInspector`, which receives Live's structural `inspector` hook (the
   component catalog and each top-level render's public state, redacted by key
   and bounded in size).
2. **Production safety is enforced three times.** `DevtoolsModule.register`
   and `new DevtoolsInspector()` throw when the environment is `production`;
   without an explicit `environment`, every request re-checks `NODE_ENV` and
   answers 404 in production; every resource also requires the host
   `authorize(request)` policy. `nestvexa doctor --production` fails when the
   module is registered without a `NODE_ENV` guard.
3. **The browser extension is out of scope for v1.** No extension source,
   build or store listing is shipped. The DX-034 requirement is satisfied by
   the in-app panel plus this record.
4. **`data.json` is the stable contract a future extension would use.** The
   response carries `schema: "nestvexa-devtools/1"` and the `DevtoolsSnapshot`
   shape exported by `@nestvexa/observability`:

   | Field                                                                                | Content                                                                                                                                                                                |
   | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `schema`                                                                             | `"nestvexa-devtools/1"`                                                                                                                                                                |
   | `generatedAt`                                                                        | ISO timestamp                                                                                                                                                                          |
   | `components[]`                                                                       | `name`, `view`, `lazy`, `actions[]`, `states[]` (`name`, `writable`), `computed[]`, `children[]`, `listeners[]`, `realtime`                                                            |
   | `renders[]`                                                                          | newest first: `at`, `requestId?`, `component`, `cause` (`mount`/`action`/`sync`), `action?`, `fields[]`, `revision`, `stateBytes`, `htmlBytes`, redacted `state`, `validationErrors[]` |
   | `summary[]`                                                                          | per span name: `count`, `errors`, `p50`, `p95`, `max` (ms)                                                                                                                             |
   | `spans[]`                                                                            | newest first: `name`, `outcome`, `milliseconds`, `attributes`, `at`, `traceId?`, `requestId?`                                                                                          |
   | `requests[]`, `actions[]`, `errors[]`, `hooks[]`, `realtime[]`, `jobs[]`, `assets[]` | subsets of `spans` by name or outcome                                                                                                                                                  |
   | `renderers[]`                                                                        | `renderer` (`live`, `inertia-document`, `inertia-json`, `ssr`) and `count`                                                                                                             |

   Within version 1 fields may be added, never removed or retyped; a breaking
   change uses `nestvexa-devtools/2`. The same authorization and production
   gates apply to `data.json`, so an extension could only read it from a
   development server the developer is signed in to.

## Rejected alternatives

- **Ship an unpublished extension (source + build only).** It would need its
  own build, per-browser manifests and functional tests in three engines for a
  view of data the panel already shows; without store publication few users
  would install it.
- **Inject a client-side overlay into application pages.** It would add script
  to every page (CSP nonce plumbing, client bundle budget) and run inside the
  application's origin with access to its DOM; the separate server-rendered
  page keeps the inspector isolated and script-free.

## Consequences

- Client-only data is not in the panel: DOM morph timing in the browser and
  client network batching are visible through the browser's own developer
  tools and through `@nestvexa/client` diagnostics; the server records the
  size of the HTML each morph applies (`nestvexa.response_html_bytes`).
- Cache hit/miss and computed prop resolution have no instrumentation hook yet
  and are not shown.
- Public state is shown with sensitive keys redacted; values under other keys
  are visible to whoever passes `authorize` on a development server, the same
  data the template already renders.

## Evidence

- `tests/devtools-inspector.test.ts`: catalog, re-render causes, redaction,
  request-id correlation, CSRF error codes, escaping, CSP, authorization,
  production refusal and bounded storage.
- `tests/devtools-browser.test.ts`: the panel in a real browser (Chromium,
  Firefox and WebKit with `NV_UI_BROWSERS`), zero CSP violations, no scripts,
  axe in light and dark schemes, keyboard navigation.
