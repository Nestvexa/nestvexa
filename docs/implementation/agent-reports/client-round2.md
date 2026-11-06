# Agent report: browser runtime and directives, round 2 (BROW, DIR)

Branch `worktree-agent-aab4b9bf0cadcba03`. Scope: `packages/client`, `packages/alpine`,
`packages/live` (nested writable paths, protocol headers, idempotent marker),
`packages/nestvexa` (boot module), `examples/directive-lab`, tests and docs.

Client bundle: **46,550 gzip bytes** (budget 49,152; 45,445 at the start of this work,
`pnpm size:check`). No budget change; recorded in the ADR 0031 amendment.

## New and changed tests

| Test file                                                                          | What it proves                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/live-writable-paths.test.ts` (new; integration + security)                  | Path allowlist grammar (17 rejection rows), comparison verdicts (13 rows), `describeLiveState().writablePaths`, Express and Fastify: allowlisted leaves through `$sync` and actions; sibling, nested sibling, injected key, removed key → `STATE_LOCKED`; leaf/whole kind change → `STATE_TYPE`; validate callback → `STATE_INVALID`; rejection consumes nothing |
| `tests/live-client-negotiation.test.ts` (new; integration + security)              | `data-nv-idempotent` lists exactly the idempotent action ids; action and `$sync` replies carry `x-nestvexa-protocol` / `x-nestvexa-capabilities`; another major → `426 UNSUPPORTED_PROTOCOL`; identical idempotent retry replays (Express and Fastify)                                                                                                           |
| `tests/client-directive-combinations.test.ts` (extended)                           | Now runs every row in **Chromium, Firefox and WebKit** (`NESTVEXA_MATRIX_BROWSERS` narrows locally). New groups: nested paths and checkbox groups (9), transport (11), restored drafts and development inspection (6), sort keyboard and pointer (7), ownership: islands/ignore/replace/portals (4). Results below                                               |
| `tests/client-models.test.ts` (extended)                                           | Nested path grammar (accept/reject), checkbox group reads (order, casts, empty, duplicates, invalid), single checkbox `.number` rejected on read, group projection, file-input and contenteditable policy messages                                                                                                                                               |
| `tests/client-layout-shift.test.ts` (new; integration)                             | Chromium Layout Instability: positive control (> 0.01), score 0 for repeated in-place morphs, class/`aria-busy` loading, delayed indicator in reserved space, scroll container                                                                                                                                                                                   |
| `tests/alpine-start.test.ts` (extended)                                            | `adoptLiveAlpine`: configure → mount without start, host starts Alpine and `$live` works, pagehide disposal; `hostAlpine` reads data properties only (accessor never invoked); incompatible host version rejected before mount and fails closed; coalescing with a started document; `startLiveAlpine` refuses an adopted host                                   |
| `tests/browser/directive-lab.spec.ts` (extended; base URL now `DIRECTIVE_LAB_URL`) | Real Nest server: nested paths + checkbox group through the allowlist; forged `address.verified` write → `422 STATE_LOCKED` and the component keeps working; idempotent `deposit` retried after a dropped request **and** a lost committed reply, executed once; `nv:sort` keyboard and pointer moves applied by the server                                      |
| `tests/umbrella-live.test.ts`                                                      | `boot.js` contains the host-adoption branch                                                                                                                                                                                                                                                                                                                      |

## Per ledger row

**DIR-006 `nv:model`** — Implemented: dotted nested paths (≤ 8 identifier segments) for
`nv:model` and the state bindings; one draft per path, sent as the whole top-level field
built from current server state (`packages/client/src/index.ts`, `grammar.ts`); server-side
nested writable allowlist `@State({ writable: ['city', 'geo.lat'] })` compared with the
stored value before component code (`packages/live/src/writable-paths.ts`, `metadata.ts`,
`runtime.ts`); checkbox groups over array state (casts, uniqueness/bounds, document
order, server projection, multiple-select aliases, native reset) in `models.ts` and
`form-reset.ts`; radio groups on nested paths; file inputs rejected with a pointer to
`nv:upload` (the uploads integration that models upload tokens); `contenteditable`
not modelled (policy, matches the BROW-008 rule that editor HTML is never state).
Tests: `live-writable-paths`, `client-models`, matrix group "nested paths and checkbox
groups" (3 browsers), lab spec. Docs: `docs/guides/nested-models.md`,
`docs/reference/directives.md`, ADR 0004 amendment. Gaps: `nv:model` on a file input is
deliberately unsupported (use `nv:upload`); array-index paths are rejected by design.

**DIR-008 `nv:dirty`** — Restored-snapshot lifecycle: at registration, model controls the
browser changed from their server-rendered default (reload/history/autofill
restoration) with a valid value differing from state become drafts; `nv:dirty` shows
them, the next request carries them, and the root dispatches `nestvexa:restored`
(`{ fields }`). Markup without a rendered value is not mistaken for an edit;
unrepresentable restored values are never sent. `nv:dirty="field"` also covers nested
path drafts. Persisted BFCache already keeps the client and drafts (Alpine bootstrap).
Tests: matrix group "restored drafts and development inspection" (3 browsers).
Gap: restoration is emulated by setting control values before mount; a real
reload-restoration run is browser-specific (Firefox restores on reload, Chromium on
history) and was not automated.

**DIR-016 `nv:stream`** — Decision documented, not implemented: HTML fragment streaming
would apply markup before commit, outside revision checks, and partial HTML cannot pass
fragment/directive validation (ADR 0017 amendment). The spec's safe text/HTML semantics
are met by escaping. Recommend recording as a deliberate decision.

**DIR-017 `nv:sort`** — Combination rows in three browsers: Alt+ArrowDown, Alt+End,
Alt+Home, ignored unmodified/Shift/Control arrows and edge moves, native pointer drag to
upper/lower halves, moves blocked while pending with `nv:loading`, inert inside
`nv:ignore`; real-server keyboard + pointer moves in the lab. Gap unchanged: touch, grid,
cross-list; manual assistive-technology checks.

**DIR-019 `nv:ignore` / DIR-020 `nv:replace`** — Interplay rows: `data-nv-island` DOM
and inert directives preserved across morphs; island inside `nv:ignore` survives, inside
`nv:replace` is torn down (before-remove/after-insert) and re-rendered; portal content
moved out of the root is unowned (inert, server copy re-rendered); documented portal
pattern (target inside `nv:ignore`). Spec 8.3 does not list `nv:teleport`; spec 8.2
requires documenting/enforcing portals — documented as "no teleport; portal targets in
`nv:ignore`" (ADR 0004 amendment). Gap: renderer-specific island hydration/teardown stays
with the islands owner.

**BROW-005** (Alpine adapter) — `adoptLiveAlpine(alpine, client)` binds Live to a
host-owned Alpine (version/API validation, `$live`, mount, no `start()`), sharing
document ownership with `startLiveAlpine`; `hostAlpine()` reads `window.Alpine` only as a
data property; the default `boot.js` adopts a host Alpine when present, otherwise starts
the bundled CSP Alpine. Tests: `alpine-start` (5 new), `umbrella-live`. Docs:
`packages/alpine/README.md`. Gap: version support stays 3.17.x (only version tested);
an Alpine already started before adoption cannot be detected through public APIs
(documented: adopt before the host starts Alpine).

**BROW-006** (scheduler, bundler, retry, version negotiation, diagnostics) — Request
bundling: a queued `$sync` folds into a not-yet-started request of the same component
(forced refreshes excluded); cross-component batching rejected with rationale (ADR 0031
amendment). Retry with jitter for safe requests only: server-declared idempotent actions
(`data-nv-idempotent`), same bytes and `requestId`, network/timeout/409/429/502/503/504,
two resends, full jitter; never `$sync`, never undeclared actions, never 4xx such as 422.
Version negotiation: Live replies advertise `x-nestvexa-protocol` and
`x-nestvexa-capabilities`; the client reports another major or `426` as `PROTOCOL` and
suspends. Tests: matrix transport group (3 browsers), `live-client-negotiation`, lab
dropped-request/lost-reply retry against the real server. Docs:
`docs/guides/client-transport.md`, `docs/reference/live-protocol.md`, ADR 0031.
Gaps: distributed fault/long-memory acceptance; read-only GET navigation and streams are
not retried (streams keep "no automatic retry" by ADR 0017).

**BROW-008** (layout shifts, focus, …) — Layout-shift measurement with
`PerformanceObserver('layout-shift')` in Chromium: positive control plus zero shift for
in-place morphs, loading class/`aria-busy`, delayed indicator in reserved space and a
scroll container (`tests/client-layout-shift.test.ts`). Gaps: Firefox/WebKit do not
implement the Layout Instability API; manual NVDA/VoiceOver checks.

**BROW-020** (progress, retry with jitter) — `nestvexa:request` events (`start`,
`retry` with attempt, `end` with outcome; action id only, no state/tokens/URLs/payloads)
as progress UI hooks, plus the idempotent-only retry above. Tests: transport rows assert
the exact event details. Docs: client transport guide. Gap: streaming progress UI beyond
existing `nv:upload.progress` and text chunks.

**BROW-022** (developer instrumentation) — `createLiveClient({ development: true })`
enables `inspect()` (per component: id, name, revision, pending per action, draft
**names**, invalid count, failure code, idempotent actions) and mirrors reported errors to
`console.warn`; without the gate `inspect()` throws. A test asserts that typed draft
values, the CSRF token, the snapshot reference and the endpoint never appear. The
umbrella boot never enables it. Docs: `docs/guides/client-diagnostics.md`. Recommend
Done.

## Test runs (this branch)

- `pnpm exec vitest run tests/live-writable-paths.test.ts tests/live-client-negotiation.test.ts` — 62 passed.
- `NESTVEXA_MATRIX_BROWSERS=chromium pnpm exec vitest run tests/client-directive-combinations.test.ts` — 112 passed (before the 4 ownership rows); ownership rows 4/4 in Chromium.
- Firefox + WebKit full matrix run (112 rows each, before the ownership rows) — 219 passed, 5 failed on the loaded host: a Firefox `fill` dispatching two input events (row made robust), timing-sensitive rows whose margins were widened (model debounce 300 → 2000 ms, `nv:loading.attr.delay` 100 → 1000 ms), and hook/test timeouts. Rerun after the fixes: those rows plus the 4 ownership rows pass in Firefox (9/9) and WebKit (9/9). The complete three-browser matrix was not rerun end to end after the last fixes.
- After merging main: `live-writable-paths`, `live-client-negotiation`, `live-action-options`, `live-model` 112 passed; `client-runtime-resilience`, `client-csp`, `client-form-reset` 82 passed; `pnpm lint`, `tsc -p tsconfig.tests.json`, `prettier --check` on changed files and `pnpm docs:build` pass; `pnpm size:check` 46,550/49,152.
- `tests/client-models.test.ts` 116 passed; `tests/alpine-start.test.ts` 26 passed; `tests/client-layout-shift.test.ts` 5 passed; `tests/umbrella-live.test.ts -t boot` 6 passed; `tests/client-form-reset.test.ts` passed when run alone (failed only as a 7-file parallel batch on the loaded host).
- Known flaky on this loaded host: the pre-existing lab scenario "quick work that never flashes" in WebKit (a 300 ms delay threshold; the first quick request took longer once).
- Directive lab (port 3440, uncommitted `playwright.local.config.ts`): Chromium 10/11 — the failure was a locator ambiguity the new "Save profile" button introduced in a pre-existing scenario, fixed with `exact: true` (that scenario then passed in WebKit; Chromium not rerun). Firefox + WebKit: 18/22 — every new scenario passed in WebKit; in Firefox the new scenarios passed (the retry scenario alone after a browser crash). The other failures were Firefox startup crashes (`RenderCompositorSWGL`) and timeouts of pre-existing dblclick/loading scenarios on the loaded host; the Firefox accessibility scan passed when rerun.

## Merge notes

- `package.json`: `live-writable-paths` and `live-client-negotiation` added to
  `test:integration` and `test:security`; `client-layout-shift` to `test:integration`.
- `tests/client-directive-combinations.test.ts` now launches three browsers; expect about
  3× its previous runtime in `test:integration`.
- `tests/browser/directive-lab.spec.ts` reads `DIRECTIVE_LAB_URL` (default
  `http://127.0.0.1:3360`); no root `playwright.config.ts` change was needed.
- `tests/support/live-fixture.ts` `Reply` gained `headers` (additive).
- Shared files likely to conflict: `packages/client/src/index.ts` (invoke/schedule,
  discover registration, `report`, API object), `packages/client/src/transport.ts`
  (protocol check before `response.ok`), `packages/client/src/grammar.ts` (new
  `PROTOCOL` code, `parsePath`, `readPath`), `packages/live/src/live.module.ts`
  (`protocolHeaders` on action/`$sync` routes) and `packages/live/src/runtime.ts`
  (`data-nv-idempotent`, nested path check in `validatedUpdates`). An engineer working on
  protocol/asset-version rows should keep the `PROTOCOL` code and the
  `x-nestvexa-protocol` check rather than adding a second mechanism.
