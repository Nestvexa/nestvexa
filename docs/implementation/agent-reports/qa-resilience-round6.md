# QA resilience, accessibility, performance and scale (round 6)

Branch `r6-qa-resilience` from main `bb1527b`. Ports used, all in 4200–4239:

- browser-lab 4201, starter-live 4202, admin-i18n 4203, showcase 4204;
- bench servers 4210–4211;
- scratch scans 4220;
- fault server 4230–4232, one port per browser project.

Docker was used only for the `nv-r6-redis` container on host port 6399, for
one real-Redis restart check. It was removed afterwards.

## QA-073: fault injection

| Fault                                              | Test                                                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session destroyed while a Live action is in flight | `tests/browser/fault-injection.spec.ts` (browser-lab)                                                                               | The request is held in a route while another request signs out (`POST /logout` destroys the express-session and revokes its Live state), then released. Reply `401` with no state, identity, CSRF token or reference. `nestvexa:error` `HTTP`. The DOM keeps the last render. A reload starts a new session that works.                                                                            |
| Session expires while an action is in flight       | same spec, against `tests/support/fault-server.ts`                                                                                  | A signed-cookie session with a 3 s TTL. The request is held until expiry, then released. Reply `401`, nothing is applied, and signing in again recovers.                                                                                                                                                                                                                                           |
| Backend restart between state updates              | same spec, fault server killed with `SIGKILL` and restarted                                                                         | The identity survives the restart (signed cookie); the in-memory Live state does not. The next action gets `410 INVALID_SNAPSHOT`, the component is suspended (`data-nv-suspended`), the reload hint shows, and further clicks send nothing. Reloading gives a page from the new process with fresh state that works.                                                                              |
| Client runtime or Alpine module unavailable        | same spec, `boot.js` and the asset routes answer `404`, or only `alpine.js` does                                                    | The server-rendered page, its state and its controls are present. The `nv:submit` form posts natively to its host route `/note`, and the redirect shows the saved note. Plain links navigate. Finding: a missing Alpine module stops the default boot module, so Live does not boot either and the page runs on its no-JS path. That is safe, but it means Live depends on Alpine being available. |
| Throttled slow network                             | same spec: Chromium CDP `Network.emulateNetworkConditions` (400 ms, about 50 KB/s each way); Firefox and WebKit: 400 ms route delay | Three quick clicks are each applied once, in order. `aria-busy="true"` is set while they are pending and cleared afterwards. No errors.                                                                                                                                                                                                                                                            |
| Islands signing-key rotation and invalid keys      | `tests/islands-key-rotation.test.ts`                                                                                                | A three-phase rolling deploy across replicas (`[old]`, then `[new, old]` and `[old, new]` in the same window, then `[new]`). Retired, foreign and tampered tokens, moved expiry, truncated and non-string tokens, and expiry across rotation are all refused. Weak or missing keys fail at boot. Live snapshots are opaque store references, not signed tokens, so they have no key to rotate.     |
| Unhandled promise rejections on the server         | `tests/support/no-unhandled-rejections.ts`                                                                                          | A process-level `unhandledRejection` hook fails the test during which a rejection occurred. It is imported by 12 server-side failure suites (listed below). The fault server runs with `--unhandled-rejections=strict`, and its output is checked after each test.                                                                                                                                 |

Suites with the guard: `live-request-boundary`, `realtime-distributed`,
`uploads-http`, `vite-ssr`, `live-stale-revision`, `client-runtime-resilience`,
`live-async`, `realtime-hub`, `inertia-http`, `live-limits`, `circuit-breaker`
and `islands-key-rotation`. All of them pass with the guard except one test in
`live-request-boundary`, which times out with and without it (see below).

Fix found along the way: `RespConnection` could wait forever when Redis closed
the socket between connecting and writing a command. It now fails with
`Redis connection closed`.

Remaining QA-073 gaps:

- There is no check that persistent resources (handles, sockets) return to
  their baseline after each fault.
- No upload is interrupted by a session loss mid-transfer.
- No network partition or crash happens during a store commit (beyond the
  existing Redis tests).

## QA-075 / QA-030: accessibility

`tests/browser/display-accessibility.spec.ts` covers six pages:

- starter-live: counter (`/`) and work board (`/board`);
- admin dashboard (`/admin`);
- UI kit (`/admin/kit`);
- showcase: sign-in and tasks (signed in).

It checks each page in three ways:

- **Reflow at 640 and 320 CSS px** (200% and 400% zoom of a 1280 px window).
  The page must not scroll horizontally, and no text, control, heading, cell
  or list item may end outside the viewport or be clipped by its own box.
  Content inside a horizontally scrolling container is allowed (the WCAG
  1.4.10 table exception).
- **Forced colors** (Chromium; Firefox and WebKit cannot emulate it).
  `emulateMedia({ forcedColors: 'active' })` must match the media query.
  Every focus stop in the first 12 Tab presses must keep an outline, and axe
  must find no violations against the forced palette.
- **The UI kit theme under forced colors.** A separate test checks that the
  alert accent becomes the system `CanvasText` color.

WCAG 2.2 AA in axe: the new shared helper `tests/browser/axe.ts` is used by all
28 browser specs and suites that had axe checks.

- `axe(page)` runs axe's default rule set plus `target-size` (SC 2.5.8, the
  only `wcag22aa` rule in axe-core 4.14.0, which is off by default). It
  replaces every untagged `new AxeBuilder({ page })`.
- `wcagAxe(page)` runs the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and
  `wcag22aa` tags. It replaces every tagged builder, several of which lacked
  `wcag22aa`.

`docs/testing/accessibility-checklist.md` records the automated coverage. Its
manual screen-reader pass is still **"Status: not executed"** and is left for
the owner. QA-030 depends on that pass and on the SEC rows.

Fixes the new checks found:

- **`@nestvexa/ui`.** `.nv-data-table` now scrolls horizontally inside its own
  box. Before, the UI kit page scrolled sideways at 320 px. Changeset
  `ui-data-table-reflow`.
- **starter-live.** Buttons and pagination links were below the 24 px
  target size (`target-size` violations on `/` and `/projects`). They now
  have a 24 px minimum (`activity.css` in `examples/starter-live/src/main.ts`).

Scratch scan, not committed: axe `target-size` on the main pages of 19
examples, each started on 4220. Pages: starter-live (7), admin-i18n (3),
showcase, live-crud, starter-ejs, realtime-dashboard, offline-progressive,
views-tour, directive-lab, uploads (2), auth-forms (3), live-counter,
multi-tenant, hybrid-dashboard, integration-matrix, inertia-react (2),
inertia-vue, inertia-svelte, inertia-mixed.

- After the starter-live fix, every page is clean except `inertia-mixed`
  `/`. Its four framework links are 17 px tall, but no spec runs axe on
  that page, so nothing fails. A follow-up for whoever owns that example.
- Best-practice finding: axe `landmark-unique` on `/admin` under forced
  colors. The `<section>` and its scroll region share the label
  `products-caption`. The admin specs run WCAG tags only, so the forced-colors
  test uses `wcagAxe`. The duplicate landmark is not fixed.

Browser runs, local config, chromium:

- `display-accessibility`: 20 of 20 pass (starter-live 6, probe 1, admin and
  UI kit 7, showcase 6).
- `admin-ui-kit.spec`: 4 of 4 pass with WCAG 2.2 AA (the axe scan includes
  `target-size`).

Final runs in Firefox and WebKit:

- `fault-injection.spec`: 12 of 12 pass. It also passed 6 of 6 in Chromium
  earlier.
- `display-accessibility.spec`, starter-live targets and the probe: 10 pass.
  The 4 forced-colors tests are skipped by design (Chromium only).

Not run here: every other migrated spec. Most hard-code the root ports
(3102, 3110, …), which are outside this assignment's port range. The
`target-size` scan above covers their pages. The root suite must confirm
them.

## QA-003 / QA-005 / QA-013: performance

- **`pnpm bench`** (`scripts/bench.mjs`, servers in
  `tests/bench/server.ts`) measures:
  - the HBS adapter;
  - cold boot, first request and warm requests;
  - SSR throughput: Nestvexa MVC vs plain NestJS with Handlebars as the
    Express view engine, and `@nestvexa/inertia` vs a hand-written
    official-protocol Inertia responder (HTML and `X-Inertia` JSON);
  - a Live no-op action vs a plain Nest JSON POST;
  - serialized bytes (raw and gzip) for 10, 100 and 1,000 rows;
  - 10, 100 and 1,000 concurrently active Live components: mount wave,
    action wave, latency and heap per component after GC;
  - DOM patch time in Chromium for 100, 1,000 and 5,000 rows.
- **Nightly.** The `bench` job in `.github/workflows/nightly.yml` builds,
  installs Chromium, runs `pnpm bench` and uploads `benchmark.json` as
  `nightly-bench`. It records results and gates nothing. This is the only CI
  change.
- **Results.** `docs/testing/benchmarks.md`, raw data in
  `docs/implementation/bench-evidence-2026-11-14.json`. The run was on a
  saturated shared Windows laptop. Within that run:
  - HBS pages: 369 vs 1,061 req/s.
  - Inertia JSON: 1,415 vs 3,412 req/s.
  - No-op action: 272 vs 996 req/s.
  - Nestvexa therefore costs about 3 to 5 times the plain-Nest baselines per
    request, and Inertia about 1.5 to 2.4 times. This has not been profiled.
- **Other findings.**
  - The default `views.cache: false` cut HBS throughput to 93 req/s in the
    first run, so the bench turns the cache on.
  - A 1,000-row Live component is refused with `413`: its state exceeds the
    64 KiB `LIVE_LIMITS`.
  - Heap per active component is about 8 KB at 1,000 components.
  - The DOM patch of 1,000 keyed rows takes about 128 ms.
- **QA-005.** The cold first render through Nest and the no-op action
  overhead are now measured, as is the Nest POST comparison.
- **Not measured** (listed in `docs/testing/benchmarks.md`):
  - React, Vue and Svelte SSR server throughput;
  - build output size over time;
  - database requests caused by rendering;
  - two replicas plus Redis compared with one process;
  - reconnect and shutdown timing under load;
  - Playwright tracing or performance profiles;
  - a pinned machine.
- **Budgets.** The `scripts/load.mjs` budgets have not been revised. No
  target is claimed as met.

## QA-010 / QA-006: scale

- **Morph (QA-010).** `tests/morph-scaling.test.ts` runs the built
  `morphChildren` in Chromium on six scenarios at 1,000 and 5,000 rows: a
  keyed table update, a reversal, churn (every 10th row replaced), a keyed
  table with a selection checkbox per row, an unkeyed list prepend, and a
  form with one labelled input per row.
  - It asserts DOM equality with the fragment, keyed identity kept,
    mutations > 0, and a median-time growth below 12.5 for 5 times the rows
    (quadratic growth would be about 25).
  - A second identical morph of 5,000 rows must make 0 mutations.
- **Bug found and fixed.** The checkbox scenario was quadratic.
  `control-state.ts` computed `path()` for every unnamed, unkeyed control with
  `[...parent.children].indexOf(node)`; 5,000 rows did not finish in 120 s.
  Sibling positions are now computed once per parent per capture pass
  (before the patch and again in `restore`). The scenario now takes about
  8 s for the whole test. `pnpm size:check`: Live core 39,730 gzip bytes of
  45,056, all Live code 54,982 of 61,440. The complexity analysis is in the
  ADR 0010 status update (2026-11-14).
- **Nesting and batch bounds (QA-006).** `tests/live-limits.test.ts` runs on
  Express and Fastify, 10 tests:
  - 8 nested levels below the root mount; 9 are refused ("depth limit").
  - 200 children in one render mount; 201 are refused.
  - Grandchildren count against the same 200 budget: 100 rows with one
    nested pair each mount, 101 are refused.
  - An action whose render would exceed the budget gets a 5xx with no detail
    and commits nothing. Following the store contract, the failed transaction
    invalidates the state, so the next request gets `410` and the browser
    reloads instead of replaying. A fresh mount at the limit still works.
  - The update batch: one request may update every declared writable field;
    a batch naming any read-only or undeclared field is refused whole with
    `422 STATE_LOCKED` before the action runs; more entries than the
    5,000-node budget get `413`. Refused batches change nothing.
- **Server batch size.** No new limit was added. Each Live request carries one
  component and one action, and its `updates` object is already bounded: by
  the declared writable fields (anything else is a `422`), by
  `LIVE_LIMITS.maxNodes` and `maxBytes` (`413`), and by the per-identity
  `maxRequestsPerMinute` limit (`429`, existing tests). The tests above prove
  the bound. The client's cap of 16 pending operations per component still
  has no dedicated test.

## QA-018: circuit breakers and timeouts

`circuit-breaker.ts` is one file copied into `@nestvexa/realtime-redis`,
`@nestvexa/uploads`, `@nestvexa/ai` and `@nestvexa/mail`, so these packages
stay free of dependencies. Each package exports `CircuitBreaker`,
`CircuitOpenError` and their types.

The breaker opens after `failureThreshold` consecutive failures (default 5)
and fails fast for `cooldownMs`. After the cooldown it lets exactly one probe
through, while concurrent calls still fail fast. Calls the caller classifies
as answers reset the count. There is an `attempt()` API for streams and
generators.

| Service                                                                                      | Wiring                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis (`RespConnection`, used by `RedisLiveStore`, `RedisJobQueue` and `RedisPresenceStore`) | Breaker per connection, default 5 failures and a 1 s cooldown. Connection failures, closes and timeouts count; `-ERR` replies never do. The connection attempt is now bounded by `commandTimeoutMs` (previously the operating system's connect timeout). The Live store maps an open circuit to the same retryable `503 STORE_UNAVAILABLE`, with `CircuitOpenError` as `cause`. |
| S3 (`S3Storage`)                                                                             | Network errors, timeouts and 5xx count; 4xx never does. While open: `502 STORAGE_FAILED` with no request sent, and the unsent upload read stream is closed (that file handle was not released before).                                                                                                                                                                          |
| clamd (`ClamdScanner`)                                                                       | `connection`, `timeout` and `closed` verdicts count; a cancelled scan or a file read error releases the call; other verdicts succeed. While open: `{ status: 'error', reason: 'unavailable' }`, without connecting or opening the stored file, so the upload still fails closed.                                                                                                |
| AI (`AiAssistant`)                                                                           | Provider errors and turn timeouts count. Cancellations are released. Server-side refusals of model output (length, unknown tool) prove the provider answered. While open, the turn fails at once with `turn.failed`, detail `UNAVAILABLE`.                                                                                                                                      |
| Mail (`Mailer`)                                                                              | New `sendTimeoutMs` (default 30000). Failures and timeouts count. While open: `MailError('TRANSPORT_FAILED')` without calling the transport. `onDelivery` reports `TRANSPORT_TIMEOUT` or `CIRCUIT_OPEN`.                                                                                                                                                                        |

Every client exposes a `circuit` getter, accepts
`circuitBreaker: { failureThreshold, cooldownMs }`, and turns the breaker off
with `circuitBreaker: false`.

Tests: `tests/circuit-breaker.test.ts`, 34 tests.

- The four copies are byte-identical.
- The behaviour suite runs against each copy.
- Each service is tested against real local TCP or HTTP servers that fail on
  demand, counting accepted connections and requests to prove that nothing
  reaches a downed service while the circuit is open.
- Redis cases: the circuit recovers after a reset; a server that never
  answers is bounded by the timeout; error replies don't count; the Live store
  maps an open circuit to 503; the breaker can be disabled.
- S3 cases: 503, 404 and a hung server; 4xx does not count; the stream of a
  refused upload is closed (the test deletes the file on Windows).
- clamd: outage and recovery, and a cancelled scan.
- AI: the provider goes down, the circuit opens and the provider recovers;
  timeouts count, cancellations don't.
- Mail: a hung transport, then a failing one, the circuit opens and the
  transport recovers; no recipient appears in events; the timeout is
  validated.

Docs:

- `docs/guides/resilience.md` (new);
- the READMEs of the four packages;
- changeset `.changeset/optional-service-circuit-breakers.md`.

**Real Redis check** (scratch script, not committed). Redis 7 ran in a
container on 6399, which was removed afterwards. With the container stopped,
three commands failed with `Redis connection closed`. The Docker port proxy
keeps accepting connections, so they were closes rather than refusals. The
circuit then opened, and the next calls failed fast in about 0.1 ms. After
`docker start`, the first probe got `PONG` and the circuit closed. A
`RedisLiveStore` create and peek worked afterwards. This is not part of
`pnpm test:services`; adding it there is a follow-up.

Not covered:

- The Redis pub/sub broker (`RespRealtimeBroker` in `@nestvexa/realtime`)
  keeps its resubscribe backoff and has no breaker.
- The `@nestvexa/cache` store is host-supplied and has no breaker.
- Breaker state is per process and not shared between replicas.
- Nothing retries automatically.

## Commits

The `r6-qa-resilience` branch was merged with main `4d90152`:

- `bc1629a` fix(client): linear control capture, plus morph scaling tests
- `5a9e03d` test(live): nesting depth, children per tree and update batch bounds
- `0541b68` feat(resilience): circuit breakers and timeouts for the optional services
- `6c3fcf9` chore(changeset): client linear control capture
- `88d26c2` test(fault): session loss mid-action, backend restart, asset outage, slow network, key rotation
- `172109f` test: unhandled-rejection guard on the server-side failure suites
- `8edea8c` test(a11y): WCAG 2.2 AA axe helper, reflow and forced colors, UI table and starter-live fixes
- `6837d28` perf(bench): comparative benchmarks and the nightly job
- `e0b2752` test(client): the 16-operation queue cap
- the merge of main `4d90152` (`package.json` test groups conflict resolved as a union)
- docs(resilience): guide formatting

## Commands run (all pass unless noted)

- `pnpm install --frozen-lockfile`, `pnpm build`, and package builds after the
  merge.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: clean, after the merge.
- `pnpm lint` (eslint and boundaries): clean, after the merge.
- `prettier --check` on every file this branch changed.
- `pnpm size:check`: Live core 39,750 gzip bytes of 45,056, after the merge.
- vitest, one file at a time:
  - `circuit-breaker` 34/34, `morph-scaling` 7/7 (both rerun after the
    merge);
  - `live-limits` 10/10, `islands-key-rotation` 4/4;
  - `client-transport-lifecycle` (new test), `client-native-controls` 39/39,
    `client-form-reset` 59/59;
  - `mail` 12, `mail-security` 7, `ai-approval` 24, `ai-stream` 5,
    `ai-provider` 13, `uploads-s3` 19;
  - `realtime-distributed` 14, `realtime-job-queue` 15,
    `live-store-contract` 69, `uploads-http` 32, `vite-ssr` 14,
    `live-stale-revision` 10, `client-runtime-resilience` 22, `live-async` 40,
    `realtime-hub` 17, `inertia-http` 40.
- Pre-existing failures, also failing on main without this branch's changes:
  - `tests/live-request-boundary.test.ts`: "answers 429 RATE_LIMIT…" times out
    at 15 s on this host. It fails the same way with the guard import
    removed.
  - `tests/ssrf.test.ts`: "matches the reviewed inventory exactly". It finds
    an unreviewed `packages/cli/src/templates-resource.ts:fetch`, which is
    not from this branch.
- Playwright through the uncommitted `playwright.local.config.ts`, ports
  4201–4204: the runs listed above.
- `pnpm bench`: twice. The second run, with the view cache on, is the
  recorded one.

## For the coordinator

- **Root `playwright.config.ts`.** No new `webServer` entry is needed.
  - `fault-injection.spec.ts` uses browser-lab (3860, already present) and
    starts its own fault server on 4230 (Chromium), 4231 (Firefox) and 4232
    (WebKit). Override the base with `NV_E2E_FAULT_PORT`. Keep those ports
    free in CI.
  - `display-accessibility.spec.ts` uses starter-live 3102, admin-i18n 3110
    and showcase 3124, all already present. Its describe names contain
    "accessibility", so `pnpm test:accessibility` picks it up.
- **`package.json`.**
  - `test:integration` gains `live-limits`, `circuit-breaker` and
    `morph-scaling`.
  - `test:security` gains `live-limits` and `islands-key-rotation`.
  - `bench` is still `node scripts/bench.mjs`, which now spawns
    `tests/bench/server.ts` through `tsx`.
- **CI.** Only `.github/workflows/nightly.yml` changed: a new `bench` job.
  Expect no conflict with `r6-qa-gates` beyond adjacent jobs.
- **Changesets.**
  - `optional-service-circuit-breakers` (minor): realtime-redis, uploads, ai,
    mail.
  - `linear-control-capture` (patch): client.
  - `ui-data-table-reflow` (patch): ui.
- **Expected conflicts.**
  - The 28 browser specs now import `./axe.js` instead of `AxeBuilder`; any
    branch that adds an axe check should use `axe()` or `wcagAxe()`.
  - The `package.json` test lists.
- **Possible new `target-size` failures** in specs I could not run on their
  hard-coded ports. The scratch scan found violations only on starter-live
  (fixed) and inertia-mixed `/` (no axe test there).
- **Ledger.** QA-075 and QA-030 stay open for the manual screen-reader pass.
  QA-003 and QA-013 stay partial: there is no pinned machine and several
  section 18.2 measurements are still missing.
