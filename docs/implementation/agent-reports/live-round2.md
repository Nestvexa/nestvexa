# Agent report: Live round 2 (server/protocol rows, kernel services, showcase fixes)

Branch `worktree-agent-ace941bdba1de6e25`, based on `main` at `23bd02d`, with `main`
(`7077831`) merged in. Every claim below names the test that proves it; integration
suites run on Express **and** Fastify unless stated otherwise. Local ports used:
3420–3422 (starter-live on 3420 for the browser runs; test origins on 3421/3422 are
never bound).

New test files: `tests/live-shared-action-policy.test.ts`,
`tests/live-domain-events.test.ts`, `tests/live-asset-version.test.ts`,
`tests/live-nesting-scope.test.ts`, `tests/live-optional-decorators.test.ts`,
`tests/core-kernel.test.ts`, `tests/client-nested-forms.test.ts` (real Chromium + fake
Live HTTP server). Extended: `tests/client-runtime-resilience.test.ts` (two offline
recovery rows), `tests/browser/realtime.spec.ts` (server-pushed domain event across two
sessions). All are registered in the root `test:integration` / `test:security`
scripts.

## LIVE-012 — `@OnEvent` for authorized cross-component/domain events

**Implemented.** `LiveEvents` (exported by `LiveModule`,
`packages/live/src/domain-events.ts`) publishes `{ nvEvent, payload }` on a realtime
channel through a **structural** publisher: the new `events` host option, or `realtime`
when it has `publish` (for example `RealtimeService`). Live does not import
`@nestvexa/realtime`; the dependency graph is unchanged. The client
(`packages/client/src/index.ts`, realtime `onMessage`) delivers a domain event only to
components subscribed to that channel (`@RealtimeChannels` + a signed subscription
token from the realtime policy) that list the event in `data-nv-listeners`, by calling
their `@OnEvent` action with the payload as input; subscribed components without a
listener refresh through `$sync` as before. The listener request goes through
admission, host `authorize`, guards and pipes.

- Tests: `tests/live-domain-events.test.ts` (message validation: names, channels,
  16 KiB, prototype keys; publisher fallback; missing publisher error; option
  validation; delivery as authorized action input; forged payload rejected by the pipe
  (400); host denial (403)). Browser: `tests/browser/realtime.spec.ts` "a
  server-pushed domain event runs the @OnEvent action in another session" (asserts
  Bob's browser POSTs `announcementPosted` with `{ id }` and renders the server-side
  text) — Chromium, Firefox, WebKit.
- Example: `examples/starter-live` `/realtime` "Announce to everyone"
  (`src/realtime-board.ts`: `Announcements`, `AnnouncementReference` pipe,
  `announce`, `@OnEvent('announcement.posted') announcementPosted`).
- Docs: `docs/reference/live-protocol.md#server-pushed-domain-events`,
  `docs/guides/nested-components.md` (Server-pushed events), `packages/live/README.md`,
  feature matrix row.
- Remaining: the payload is untrusted when it returns (documented; send identifiers);
  events published before a browser subscribes are not replayed (existing realtime
  at-most-once semantics).

## LIVE-014 — optional `@Renderless`, `@Transition`, `@Title`, `@Layout`, `@Validate`

**Implemented where meaningful** (`packages/live/src/metadata.ts`,
`schema-pipe.ts`, `runtime.ts`, client `protocol.ts`/`index.ts`):

- `@Renderless()` on an `@Action` = `@Action({ renderless: true })`; without `@Action`
  startup fails.
- `@Validate(validator)` on writable `@State`: function, Standard Schema v1 (Zod 3.24+,
  Valibot, ArkType) or `safeParse` schema; `422 STATE_INVALID` before any hook; misuse
  (locked field, double validator, invalid validator) fails at startup.
- `schemaPipe(schema)` for `@ActionInput`: passes schema output (coercion) to the
  action; failures are `400 { message, issues[] }` without echoing input.
- `@Title()` getter/method: rendered action responses carry `title` (new optional
  response schema field, 1–200 chars, no control characters, validated on both sides);
  the client applies it to `document.title` only for top-level components.
- `@Transition` and `@Layout`: intentionally not provided (README): transitions are the
  `nv:transition` directive; Live components are mounted into host-rendered pages, so
  layouts belong to the host route.
- Tests: `tests/live-optional-decorators.test.ts` (metadata, misuse, HTTP behavior on
  both platforms); `tests/client-nested-forms.test.ts` (title applied by the parent,
  ignored from a nested child).
- No third-party schema library was added: the tests use hand-written Standard Schema
  / safeParse objects of the documented shapes.

## LIVE-021 — parent/child scope, stable keys, reactive vs modelable, inheritance, DOM scope

**Documented and tested.** New guide section "Scope and inheritance rules" in
`docs/guides/nested-components.md`. `tests/live-nesting-scope.test.ts`: a child action
changes only the child (parent stored revision unchanged, response contains only child
markup); unchanged children return as stubs with the same IDs (stable keys); a changed
`@Reactive` value refreshes only that child, `@Prop` is mount-only and child-owned state
survives; a changed key mounts a new child and revokes the old snapshot (410); child
`$mount` and actions are authorized under the child's own name (a parent grant is not
inherited); `@State`/`@Action` inherited from a base class work. Existing coverage:
`tests/live-nesting.test.ts`, `tests/browser/nesting.spec.ts`.

## Showcase bug 2 — `@Reactive` 409 after side effects (part of LIVE-021)

**Fixed.** During child hooks and actions a `@Reactive` field is an accessor over a
read-only proxy view (`guardReactiveProps` in `packages/live/src/runtime.ts`):
assigning a different value or mutating nested data throws `409
REACTIVE_PROP_MUTATED` at that statement, so later code and side effects never run.
Assigning the same value is allowed. The post-action check stays as a backstop.
Test: `tests/live-nesting-scope.test.ts` "@Reactive write guard" (assignment and
`push()`; recorded side effects stay empty). Limitation: `structuredClone` of the
read-only view inside an action throws (proxies are not cloneable); copy with spread or
`JSON` instead.

## Shared idempotent replay and identity locks across replicas (LIVE-007 / PROT-017 remainder)

**Implemented.** New structural `LiveActionCoordination` interface
(`packages/live/src/action-policy.ts`): `readReplay`, `writeReplay`,
`acquireActionLease`, `releaseActionLease`. `LiveRuntime` uses it automatically when
the configured store implements it; otherwise the existing process-local policy.
`RedisLiveStore` implements it (`packages/realtime-redis/src/live-store.ts`): replay
records under `<prefix>r:<sha256>` are AES-256-GCM ciphertext sealed by Live with a key
derived from binding + snapshot token + request ID (the store holds none of them; AAD
is the storage key), identity locks are `SET NX PX` leases (`<prefix>a:<sha256>`)
lasting the component `timeoutMs` + 1 s (300 s without a deadline) and released by
`WATCH`/`MULTI` compare-and-delete.

- Tests (`tests/live-shared-action-policy.test.ts`, RESP double, replica pairs
  Express→Fastify and Fastify→Express): retry on the other replica replays exactly once;
  reused request ID with another payload → 422; another identity → 410; store holds no
  token, request ID, binding or state in replay records; tampered or relocated record →
  safe 409 with no re-execution; identity lock excludes the same identity across
  replicas (409 `ACTION_BUSY`) but not another identity, and releases; lease expiry
  after a crash; stale owner cannot release a new owner's lease; key/value validation.
- Docs: `docs/reference/live-protocol.md#action-options`, `packages/live/README.md`,
  `packages/realtime-redis/README.md`, feature matrix.
- Remaining: not run against real Redis in this round (`pnpm test:services` not run;
  only the RESP double). A replayed `download` URL is served only by the replica that
  created it (documented).

## PROT-006 — markers, listeners once, Alpine once, ownership

**Additional evidence.** `tests/client-nested-forms.test.ts` "owns nested directives by
the nearest root and attaches listeners once": a second `mount()` does not duplicate
listeners (one request per click), a click inside a nested child calls the child
endpoint and a parent click the parent endpoint, and the child keeps working after the
parent response returns it as a stub. Remaining: broad host-Alpine compatibility
acceptance (unchanged from round 1).

## PROT-007 — allowlisted delta + action ID, debounce/bundling

**Additional evidence.** `tests/client-nested-forms.test.ts` "bundles only changed
fields with the action ID in one request": deferred models send nothing, the next
action carries exactly the changed fields plus the action route, acknowledged fields
are not resent. Server allowlist: `STATE_LOCKED`/`STATE_TYPE`/`STATE_INVALID`
(existing suites, plus `tests/live-optional-decorators.test.ts`). Debounce/throttle:
round-1 directive matrices. Remaining (by design, documented in the client README):
no cross-component request batching — each component is its own Nest request and
store transaction.

## PROT-012 — stale responses, owned morphs, focus/selection/scroll

**Additional evidence / fix.** Showcase bug 3: after a nested form submit, a parent
response that refreshed the child root (`data-nv-refresh`) dropped focus to `<body>`.
The client now follows the focused element into the replacement (same `data-nv-key`
child, same element `id`) — `packages/client/src/index.ts` before the focus-restoration
block. Tests: `tests/client-nested-forms.test.ts` (button submit, implicit Enter,
parent refresh after a child event, valid submit leaves focus alone). Remaining: the
round-1 acceptance gaps (teleports, shadow DOM, multi-range selection, screen readers).

## PROT-018 remainder — asset-version mismatch

**Implemented.** Host option `assetVersion` (validated `^[A-Za-z0-9._:+-]{1,128}$`):
roots carry `data-nv-asset-version`; the client echoes it in
`x-nestvexa-asset-version`; admission compares after origin and CSRF and fails with
`409 ASSET_VERSION_MISMATCH` (catalogued, recovery `reload`) plus response header
`x-nestvexa-reload: asset-version` (set by the admission guard through
`HttpAdapterHost`). The client dispatches a cancelable window `nestvexa:reload` event
and reloads unless prevented. Tests: `tests/live-asset-version.test.ts` (missing and
stale header → 409 + header, action not run, body has only `statusCode`/`code`;
CSRF failure first without the reload header; option validation; catalog entry).
Docs: `docs/reference/live-protocol.md#asset-version`, error table, client README.
Remaining: the client reload path is covered by code review and the server header
test, not by a browser test.

## Showcase bug 1 — network failure suspended the component until reload

**Fixed.** Client (`packages/client/src/index.ts`): when `navigator.onLine` is `false`
the request is not sent and fails with `NETWORK` without suspending; a `$sync` without
a response (`NETWORK`/`TIMEOUT`) no longer suspends (no action method runs; a committed
one is caught by the next revision check). An action without a response while online
still suspends (uncertain effect). Tests: `tests/client-runtime-resilience.test.ts`
"does not send while the browser is offline and resubmits after reconnect without a
reload" and "keeps the component usable after a refresh ($sync) loses its connection";
the existing "dropped connection … recovers after remount" row still proves the
uncertain-action suspension. Docs: `docs/guides/offline.md` step 4 rewritten to the
exact behavior, `docs/guides/request-lifecycle.md`, client README.

## CORE-034 — extension API with stable hooks and capability flags

**Implemented.** `NestvexaExtension` / `defineExtension` / `NestvexaExtensionHost`
(`packages/core/src/extensions.ts`): `{ name, capabilities?, register?(context),
contributeContext?(request), shutdown?() }`; order: capability declaration →
`register` (capability, security, diagnostics registries) → context contributor, in
installation order; then capability and security registries are sealed; `shutdown` in
reverse order with isolated failures. Configured via
`CoreModule.forRoot(options, { extensions })` (and the new third argument of
`NestvexaModule.forRoot`). Tests: `tests/core-kernel.test.ts` "extension hooks"
(validation, ordering, capability report/require, sealing, contributions, shutdown,
duplicates). Docs: core README "Kernel services", architecture overview. Remaining:
no out-of-tree example package consumed from a tarball (MAINT gap unchanged); the
older `PluginRegistry` is separate.

## CORE-035 remainder — correlation IDs in error bodies and logs, redaction

**Implemented.** `NestvexaExceptionFilter` (`packages/core/src/exceptions.ts`, no
`@nestjs/core` dependency, structural Express/Fastify reply): HTTP exception bodies
(including Live `{ statusCode, code }`) gain `correlationId`, every error response
carries `x-request-id`, other errors become `500 INTERNAL_ERROR` with a fixed message;
server errors are logged once through a redacting logger with the correlation ID and
emitted as a `nestvexa.error` diagnostic. `redact`, `createRedactor`,
`createRedactingLogger` (`redaction.ts`). The Live error schema documents optional
`correlationId`. Tests: `tests/core-kernel.test.ts` (redaction unit tests; integrated
Live on Express and Fastify: incoming ID reused, malformed ID replaced, custom 422 body
kept, thrown error → generic 500, one redacted log line). Remaining: the filter is
opt-in (`app.useGlobalFilters(app.get(NestvexaExceptionFilter))`); exception messages
are logged as written apart from credential scrubbing.

## CORE-043 — `RequestContextFactory`

**Implemented** (`packages/core/src/context.ts`): one frozen context per request with
`correlationId`, 128-bit `cspNonce`, `tenant`, `session`, `principal`, extension
contributions and a `public` subset (`correlationId`, `cspNonce`, `tenant`,
`authenticated`); validated incoming `x-request-id` or random UUID
(`trustIncomingCorrelation: false` disables); resolver errors and malformed output
reject. Tests: `tests/core-kernel.test.ts` "RequestContextFactory". Remaining: views
do not yet read the CSP nonce from the factory automatically (hosts pass it).

## CORE-047 — `SecurityPolicyRegistry`

**Implemented** (`packages/core/src/security.ts`): per-owner `csrf`, `origin`,
`snapshot` (must bind identity), `action-authorization`, `upload-quota`; validated and
frozen; fail-closed `verifyCsrf`/`originAllowed`/`authorize`/`uploadAllowed`;
`require`, `seal`, function-free `report()`. The umbrella registers Live's policies
under `live` (delegating to the same host callbacks). Tests: `tests/core-kernel.test.ts`
(unit + integrated Live on both platforms). Remaining: `@nestvexa/uploads` does not
register its quotas yet; Live keeps enforcing its own copy of the policies (the
registry describes and evaluates, it does not replace Live admission).

## CORE-048 — `DiagnosticsRegistry`

**Implemented** (`packages/core/src/diagnostics.ts`): typed events/metrics/spans,
primitive bounded attributes with key redaction, `define()` catalog with `strict`
mode, isolated listeners, bounded `recent()` buffer, `instrumentation()` adapter for
the Live hook (used by default by the umbrella). Tests: `tests/core-kernel.test.ts`
(unit; integrated: `nestvexa.live.mount/action/render` spans recorded without CSRF or
state). Remaining: no exporter (OpenTelemetry stays in `@nestvexa/observability`).

## Verification

Windows 11, Node 24, on the final code (after merging `main`):

| Command                                                                                                                                                                                    | Result                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `pnpm exec vitest run` new suites: live-shared-action-policy, live-nesting-scope, live-asset-version, live-domain-events                                                                   | 4 files, 30 tests passed                                                               |
| `pnpm exec vitest run tests/core-kernel.test.ts` / `tests/live-optional-decorators.test.ts`                                                                                                | 15 / 8 passed                                                                          |
| `pnpm exec vitest run tests/client-runtime-resilience.test.ts tests/client-nested-forms.test.ts` (real Chromium)                                                                           | 28 passed                                                                              |
| Regression: live, live-security, live-pipeline, live-action-options, live-nesting, live-renderless, live-store-contract, live-model, realtime-live                                         | 9 files, 199 passed                                                                    |
| Regression: umbrella-live, canonical-api, live-protocol-contract, core, core-config, architecture-runtime                                                                                  | all passed (a first run under heavy machine load timed out; rerun individually passed) |
| Regression: client, client-events-protocol, client-renderless-protocol, client-transport-lifecycle, client-realtime                                                                        | 5 files, 155 passed                                                                    |
| Playwright (uncommitted local config, starter-live on :3420) `tests/browser/realtime.spec.ts`                                                                                              | 7/7 Chromium, 7/7 Firefox, 7/7 WebKit                                                  |
| `pnpm lint` (eslint + boundaries), `pnpm exec tsc -p tsconfig.tests.json --noEmit`, `pnpm docs:build`, `pnpm size:check` (45 850 / 49 152 gzip bytes), Prettier check on all changed files | clean                                                                                  |

Not run: `tests/browser/live.spec.ts` and `tests/browser/nesting.spec.ts` hard-code
ports 3101/3102 (root suite servers) and were not run on this engineer's ports;
`pnpm test:services` (real Redis) was not run.

## Merge notes

- `package.json`: new files in `test:integration` / `test:security` (and the
  round-1 merge conflict in those script lines was resolved by taking `main` and
  re-adding these files).
- `tests/browser/realtime.spec.ts` gains one test that runs in the existing root
  starter-live webServer entry (no new entry).
- `packages/client/src/index.ts`: edits in the request headers, the error `catch`
  (reload + recoverable classification), the post-morph focus block, realtime
  `onMessage` and `deliverEvents`.
- `packages/live/src/runtime.ts`: `executeUntraced` (shared policy, reactive guard,
  title), admission (asset version), wrapper attribute.
- `NestvexaModule.forRoot` has a third optional argument; the umbrella's Live factory
  now injects `DiagnosticsRegistry` and `SecurityPolicyRegistry`.
