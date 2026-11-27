# Agent report: devtools, browser tracing, realtime coalescing, reorder safety and island budgets (round 9)

Branch `r9-devtools9`, from main `748681d`. Packages touched:
`@nestvexa/observability`, `@nestvexa/client`, `@nestvexa/inertia`,
`@nestvexa/islands`. New example: `examples/devtools-tracing` (port 4340).
Not touched: `packages/actions`, `packages/cache`, `packages/cli`.

## Per ledger row

### DX-033 (development panel)

Implemented:

- **Browser morph timing and network batches.** `devtoolsReporter()` in the
  new browser-safe entry `@nestvexa/observability/devtools-client`
  (`packages/observability/src/devtools-client.ts`) is a Live client
  `onDiagnostic` sink. It copies only the closed timing fields, buffers at
  most 200 and POSTs batches of 50 to `POST <path>/client`
  (`packages/observability/src/devtools.ts`). The endpoint requires the host
  `authorize` check and answers 404 in production or without an inspector.
  It accepts only same-origin JSON (`Origin` host equal to `Host`,
  `Sec-Fetch-Site` same-origin when present) with `x-nestvexa-devtools: 1`
  (a cross-site page cannot send that without a CORS preflight), at most 50
  timings. `DevtoolsInspector.clientReport` validates every field (phase,
  outcome, bounded duration, component-name grammar, integer byte sizes,
  lowercase trace id) and drops everything else. The panel adds **Browser
  morph timing** (per component: count, p50, max), **Network batches** (per
  component: requests, failures, request and response bytes, average and max
  duration) and **Recent browser timings** (with trace ids). `data.json` adds
  `browser.{morphs,network,timings}`.
- **Cache hit/miss.** `DevtoolsInspector.cacheEvent(event)` is a structural
  `@nestvexa/cache` `onEvent` sink (`new Cache({ onEvent: (event) =>
inspector.cacheEvent(event) })`), with no import between the packages. It
  keeps the type, namespace, scope kind, tags (cache grammar, at most 20),
  duration, removed count and request id, and per-namespace totals (hits,
  misses, stale, coalesced, bypassed, errors, hit ratio). There are no keys,
  bindings, tenants or values. It adds the panel sections **Cache** and
  **Recent cache events** and `data.json` `cache.{summary,events}`.
- **Inertia page props (redacted).** The new `inspector` option of
  `InertiaModule` (`packages/inertia/src/instrumentation.ts`, `options.ts`,
  `service.ts#inspect`) calls `page({ component, kind, status, props,
partial?, deferred?, shared? })` per page response. A throwing inspector is
  ignored and a non-conforming one is refused at configuration.
  `DevtoolsInspector.page` redacts the props with the `redact()` rules
  (passwords, tokens, CSRF, sessions, ...), elides them over `maxStateBytes`
  and keeps the prop names, partial-reload props, deferred and shared names.
  It adds the panel section **Inertia pages** and `data.json` `pages`.
- **Example.** `examples/devtools-tracing` mounts `DevtoolsModule`
  (development only, loopback clients only) with an inspector. It also wires
  the reporter, a `Cache` feeding the inspector and the OpenTelemetry
  adapter (see DX-035).

Tests:

- `tests/devtools-browser-report.test.ts` (8, real Nest + Live + HBS):
  - panel morph and network aggregation and HTML;
  - closed-shape filtering: injected `state`/`url`/`<script>`/bad trace id,
    negative sizes and unknown phases or outcomes are dropped, and no secret
    reaches `data.json`;
  - refusals: missing header, cross-site `Origin`, `Origin: null`,
    `Sec-Fetch-Site: cross-site`, `text/plain`, unauthorized, 51 timings or a
    non-array (400), no inspector (404), and a process switched to production
    (404);
  - reporter batching, field copying, dispose, buffer bound, failing
    transport, and endpoint and `flushMs` validation.
- `tests/devtools-cache-inertia.test.ts` (6):
  - a real `Cache` + `MemoryCacheStore`: hit/miss/invalidate counts and
    request ids, with no value or binding in the snapshot or HTML;
    malformed-event filtering and bounds;
  - a real `InertiaModule` + `DevtoolsModule`: redacted props (shared
    `csrfToken`, nested `password`, `apiToken`) while the browser still gets
    the real props; deferred and shared names; partial reload; escaped
    script-free HTML; a failing inspector does not change the response;
    option validation; prop elision and invalid input.
- `tests/browser/devtools-tracing.spec.ts`: a real browser against the
  example. Browser timings reach the panel (2 requests for `meter` with
  sizes, 2 morphs, trace ids), the cache shows 1 hit and 1 miss, the panel
  has no `<script>` and the page's CSRF token appears nowhere in the panel or
  `data.json`.

Docs: `packages/observability/README.md` (Development panel, Devtools safety,
Status and limits), `docs/guides/observability.md`,
`docs/guides/client-diagnostics.md`, `packages/inertia/README.md` (`inspector`
option), `examples/devtools-tracing/README.md`.

Remaining gap: nested child re-renders, a live subscription gauge and
MVC-only renderer counts are still not shown. Browser timings cover Live
requests only, not every fetch on the page.

### DX-035 (OpenTelemetry adapter, trace context)

Implemented:

- **Client `traceparent`.** `createLiveClient({ tracing })`
  (`packages/client/src/index.ts`):
  - `true` sends a new sampled version-00 `traceparent` (random 16-byte
    trace id and 8-byte span id from `crypto.getRandomValues`) with every
    Live request;
  - a function supplies the header from a browser tracing SDK;
  - every value must match `^00-<32 lowercase hex, not all zero>-<16 lowercase
hex, not all zero>-<2 hex>$`, or no header is sent; a throwing function
    never blocks the request;
  - automatic retries of an idempotent action resend the same header;
  - a non-boolean, non-function value throws `DIRECTIVE`.
- **Richer diagnostics.** `LiveDiagnostic` adds `component`, `requestBytes`
  and `responseBytes` (request phase; the response size is reported by
  `requestLive`/`readJson` through a new optional `onBytes` callback in
  `transport.ts`) and `traceId`.
- **Server join.** The existing `traceContextMiddleware` plus
  `openTelemetryInstrumentation(tracer, { api })` parent server spans on the
  browser's span, and `MemoryInstrumentation` records the trace id. The
  header is never echoed and never used for authorization.
- **Example with a real OpenTelemetry SDK.** `examples/devtools-tracing`
  uses `@opentelemetry/api@1.9.0` and `@opentelemetry/sdk-trace-base@2.10.0`
  (`BasicTracerProvider`, `InMemorySpanExporter`). Both are example-only
  dependencies, pinned exactly; the API peer range of sdk-trace-base 2.10.0
  is `<1.10.0`. Its `/api/traces` endpoint (development, loopback only) lists
  the finished SDK spans.

Size: Live core 40,033 / 45,056 gzip bytes; all Live code 55,285 / 61,440
(`pnpm size:check`).

Tests:

- `tests/client-tracing-realtime.test.ts` "Live client trace context" (10,
  Chromium with the built client):
  - a fresh header per request, with the diagnostic `traceId`, `component`,
    exact `requestBytes` and `responseBytes`, and no CSRF token, endpoint,
    action name or snapshot in samples;
  - a host header is sent unchanged and reused on a 503 retry;
  - 7 malformed values (uppercase, zero trace, zero span, version 01,
    trailing field, CRLF header injection, empty) are never sent;
  - a throwing SDK, the default (no header) and an invalid option.
- `tests/devtools-browser-report.test.ts` "browser trace context":
  - the Live action span records the inbound trace id;
  - the OpenTelemetry bridge parent is `{traceId, spanId, traceFlags: 1,
isRemote: true}`;
  - the response never echoes the header;
  - a valid `traceparent` with a forged CSRF token gets **403
    `CSRF_REJECTED`** and no action span;
  - malformed and all-zero headers start a new trace.
- `tests/browser/devtools-tracing.spec.ts`:
  - Chromium sends the header;
  - the devtools `nestvexa.live.action` record carries the same trace id;
  - the **OpenTelemetry SDK** span `nestvexa.live.action` has the browser's
    trace id and the browser span id as its parent;
  - a forged CSRF token with a valid `traceparent` gets 403;
  - a `text/plain` report is refused.
- `tests/client-transport-lifecycle.test.ts`: the diagnostic key assertion is
  updated to the new shape.

Docs: `docs/guides/client-diagnostics.md` (new "Trace context" section),
`packages/client/README.md`, `packages/observability/README.md` (Trace
context), `docs/guides/observability.md`.

Remaining gap: `tracing: true` makes the browser the trace root but records
no browser-side span (for example a client morph span). That needs a browser
OpenTelemetry SDK, whose header can be passed through `tracing: () =>
header`. Spans for hydrate and asset lookup are unchanged by this round.

### EXT-004 (client refresh coalescing)

Implemented (tests only; the 50 ms per-component window in `invalidate()`
already existed).

Tests: `tests/client-tracing-realtime.test.ts` "realtime refresh coalescing"
(Chromium, built client, scripted `EventSource` and fetch):

- 8 distinct invalidations on one channel for one component cause **exactly
  one** read-only `_sync`, which carries `x-nestvexa-resync: 1`, the same
  revision and no drafts. Nothing more follows after the window.
- A later burst causes exactly one more refresh.
- Replayed event ids schedule nothing.
- Two subscribed components get one refresh each.

Without the window each event would schedule a forced `_sync`, which
`schedule()` does not fold.

Remaining gap (unchanged): no example declares `@DependsOn` or wires
`LiveTags.listener`, and there is no browser test of a `@DependsOn` refresh.

### EXT-007 (reorder-safe optimistic results)

Read first: `tests/browser/runtime-resilience.spec.ts` already covered one
component's stale reply and out-of-order replies of independent components.
It did not cover a stale reply across components, and the actions parallel
mode was untested.

Tests:

- `tests/actions-client-reorder.test.ts` (4; `packages/actions` unchanged):
  - parallel mode (`abortPrevious: false`): an older result arriving after a
    newer one does not overwrite state or call `onSuccess` (the caller still
    gets its own result);
  - an older success or a 409 failure settling first leaves the newest
    optimistic projection pending, then the newest result wins;
  - across components: two controllers on the same action, with A's first
    call superseded, B unaffected and A's stale result arriving last; each
    keeps its own result;
  - a parallel failure (409) rolls back only that component.
- `tests/browser/runtime-resilience.spec.ts`, new test "a reply captured for
  one component is rejected when replayed to another": cell 0's authentic
  reply is replayed as the answer to cell 1's request. It is rejected
  (`RESPONSE`), neither cell takes the foreign state, cell 1 suspends and
  cell 0 keeps working against the server.

Remaining gap (unchanged): no conflict-specific state, merge hook or UI for
409, and Live `nv:optimistic` projections stay untyped against action types.

### EXT-009 (excessive island bundles)

Implemented:

- **CI check.** `scripts/island-budgets.mjs` holds a per-island gzip table for
  `examples/hybrid-dashboard` (8 islands) and `examples/islands-vite` (3).
  `scripts/size.mjs` (`pnpm size:check`, run in CI and release) measures each
  built island's entry plus its static import closure with
  `analyzeIslandBundles`. A tighter manifest `budgetBytes` wins. The check
  fails on:
  - an overrun;
  - an island without a budget;
  - a budget for a missing island;
  - a foreign framework runtime;
  - an unbuilt example (CI builds them in `pnpm typecheck`).

  It writes `artifacts/reports/islands-budget.json`. Current sizes are
  revenue-chart 71,714/80,000, react-kpi 69,900/80,000, activity-feed
  26,868/45,000, status-widget 20,545/30,000, broken-island 488/2,000,
  origin-react 69,632/80,000, origin-vue 25,057/45,000, origin-svelte
  19,094/30,000, counter-react 67,838/80,000, counter-vue 22,974/45,000 and
  counter-svelte 10,892/30,000.

- **Development warning.** `islandBudgetWarnings(report, { budgetBytes })`
  (`packages/islands/src/build.ts`) returns one warning per island over its
  own budget or the configurable default. `islandsVitePlugin({ budgetBytes,
onBudgetWarning })` prints them (default `console.warn`) after every build,
  including `vite build --watch` rebuilds. A default-budget overrun only
  warns; an island's own budget still fails unless `failOnViolation: false`.
  The hybrid dashboard build prints them against `NV_ISLAND_BUDGET`
  (default 80000). Verified: `NV_ISLAND_BUDGET=50000` prints "Island
  origin-react (react) is 69632 gzip bytes, over its default 50000 byte
  budget by 19632 bytes".

Tests: `tests/islands-budget.test.ts` (6):

- warning sources and messages, and option validation;
- plugin: warns on every build without failing for a default budget; an
  own-budget overrun warns and then fails (or only warns with
  `failOnViolation: false`); the default `console.warn` output; option
  validation;
- `checkIslandBudgets` on fixture builds: pass, overrun, unbudgeted, stale
  and unbuilt.

Docs: `packages/islands/README.md` (Performance budgets),
`docs/guides/islands.md`.

Remaining gap (unchanged): the warning is a build-time development warning,
because an unbundled Vite dev server has no bundle sizes; there is no browser
runtime warning. N+1 detection is still tested only with TypeORM, and no
example wires `queryBudget`.

## Commands run (this worktree)

- `pnpm install --frozen-lockfile`, `pnpm build` (whole workspace), then
  rebuilt observability, client, inertia, islands, hybrid-dashboard and the
  new example.
- `pnpm exec vitest run` for each file below, one at a time:

  | File                                                          | Result |
  | ------------------------------------------------------------- | ------ |
  | `tests/devtools-browser-report.test.ts`                       | 8/8    |
  | `tests/devtools-cache-inertia.test.ts`                        | 6/6    |
  | `tests/client-tracing-realtime.test.ts`                       | 12/12  |
  | `tests/actions-client-reorder.test.ts`                        | 4/4    |
  | `tests/islands-budget.test.ts`                                | 6/6    |
  | `tests/client-transport-lifecycle.test.ts` (diagnostic tests) | 4/4    |

  The regression files listed in the final message were also run.

- `pnpm exec playwright test -c playwright.local.config.ts
tests/browser/devtools-tracing.spec.ts tests/browser/runtime-resilience.spec.ts`
  (browser-lab on 4342, the example on 4340): Chromium 12/12, plus Firefox
  and WebKit (see the final message).
- `pnpm size:check` passes; `pnpm api:update` (client, inertia, islands and
  observability reports updated); `pnpm lint`;
  `pnpm exec tsc -p tsconfig.tests.json --noEmit`.

## For the coordinator

- The root `playwright.config.ts` has a new webServer entry:
  `@nestvexa/example-devtools-tracing` on port 4340.
- Root `package.json`:
  - `test:unit` gains `actions-client-reorder` and `islands-budget`;
  - `test:integration` gains `devtools-browser-report`,
    `devtools-cache-inertia` and `client-tracing-realtime`;
  - `test:security` gains `devtools-browser-report` and
    `client-tracing-realtime`.
- `pnpm-lock.yaml` adds the example importer and the OpenTelemetry packages.
  Because `@opentelemetry/api` is now present, pnpm also re-resolved two
  optional-peer snapshots (vitest's and drizzle-orm's) with
  `@opentelemetry/api@1.9.0`. Expect lockfile conflicts with other branches
  that change dependencies; resolve them by re-running `pnpm install`.
- `pnpm size:check` now also needs the island examples built (CI's
  `pnpm typecheck` builds everything first).
- Expected conflicts:
  - README example list and `playwright.config.ts` (append-only);
  - `tests/client-transport-lifecycle.test.ts` (one assertion);
  - `tests/browser/runtime-resilience.spec.ts` (one appended test).
