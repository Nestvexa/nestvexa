# Agent report — Live core kernel, server runtime and wire protocol

Branch `worktree-agent-a7996e65702130df8`, based on `main` at `f9aea14`. Groups CORE,
PROT, LIVE (plus ARCH-010). Every claim below is backed by the named test files, which
were run on Windows (Node 24) against Express and Fastify where stated.

New test files: `tests/core-config.test.ts` (unit), `tests/live-protocol-contract.test.ts`
(unit, security), `tests/architecture-runtime.test.ts` (unit),
`tests/live-action-options.test.ts` (integration, security), `tests/live-pipeline.test.ts`
(integration, security), `tests/canonical-api.test.ts` (integration). Shared harness:
`tests/support/live-fixture.ts`. Golden fixtures: `tests/fixtures/live-protocol/`.
Changed tests: `tests/live-renderless.test.ts` (capability list semantics),
`tests/umbrella-live.test.ts` (live.client mismatch).

Docs: `docs/reference/live-protocol.md` (new), `docs/reference/configuration.md` (new),
`docs/adr/0030-live-kernel-boundary.md`, `docs/adr/0031-live-protocol-evolution-and-action-replay.md`,
`docs/guides/live-lifecycle.md` (nested order, deadlines), `docs/guides/live-protocol.md`,
`docs/guides/renderless-actions.md`, `docs/feature-matrix.md`,
`docs/architecture/package-dependency-graph.md` (ADR link), package READMEs of core and
Live, `.changeset/live-core-protocol.md`.

## Rows addressed

### Public API (section 4)

- **CORE-002 / CORE-003 / CORE-004** — The canonical `forRoot` sample now compiles and
  runs verbatim: `live.client` (`'alpine' | 'manual'`) is a validated core option, and the
  umbrella rejects a value that differs from the Live browser mode.
  Evidence: `tests/canonical-api.test.ts` (sample 4.1 on Express and Fastify),
  `tests/core-config.test.ts`, `tests/umbrella-live.test.ts`. Remaining: CLI initializer
  and Linux matrix (unchanged, outside this area).
- **CORE-005** — `forRootAsync` supports `useFactory`/`inject`/`imports`, `useClass`
  (`NestvexaOptionsFactory`) and `useExisting`, exactly one strategy enforced; opt-in
  `global` registration for feature modules; explicit precedence via
  `mergeNestvexaOptions(file, nestvexaOptionsFromEnvironment(env), overrides)` with
  defaults last; startup validation reports every invalid path. A host `ConfigService`
  is exercised with an in-test stand-in because `@nestjs/config` is not a workspace
  dependency (not added: no new deps). Evidence: `tests/core-config.test.ts`. Gap:
  feature-specific HTTP adapter capability registration is still per integration
  (umbrella adapter checks), not a central registry population.
- **CORE-010 / CORE-011** — The counter component and template sample (with
  `@Computed() get doubled`) render and run increment/decrement over HTTP on both
  platforms. Evidence: `tests/canonical-api.test.ts`.
- **CORE-014 / CORE-015** — The users-table sample: class/method `@UseGuards`
  (`SessionAuthGuard`, `UsersAdminGuard`), `@ActionInput(new ValidationPipe(...))` with a
  class-validator DTO, and an injected service; guards and DTO validation reject before
  the service runs. Evidence: `tests/canonical-api.test.ts`, `tests/live-pipeline.test.ts`.
- Not addressed: CORE-006..008 (MVC), CORE-012 (client directive parser — other
  engineer), CORE-016..021 (Inertia/actions).

### Kernel and Nest lifecycle (section 5)

- **CORE-023** — Implemented: validated sync/async config with diagnostics, capability
  declarations with degraded state, protocol version/capability negotiation (see
  PROT-002), safe shutdown (abort running operations, bounded 10 s drain of in-flight
  Live requests before the store closes) and resource cleanup (replay cache cleared).
  Evidence: `tests/core-config.test.ts`, `tests/live-action-options.test.ts` (shutdown
  drain on both platforms). Gaps: plugin registration API, logger/tracing hook beyond the
  existing Live `instrumentation`, request context factory (CORE-043).
- **CORE-025** — All new integration suites run on Express and Fastify.
- **CORE-026** — Request isolation re-proven with nested parent/child components in one
  request and across requests. Evidence: `tests/live-pipeline.test.ts` (plus existing
  `tests/live-instance-scope.test.ts`).
- **CORE-027** — Request-scoped, transient and async (`useFactory` returning a promise,
  request-scoped) providers in Live components: parent and child share the request
  context, never transient instances; a new request gets new instances. Evidence:
  `tests/live-pipeline.test.ts`.
- **CORE-030** — Full invocation order pinned on both platforms: middleware → global
  guard → Live admission (origin/CSRF/identity/rate/envelope/ownership, host
  `authorize`) → class guard → method guard → global/method interceptors → global pipe →
  parameter pipe → hooks/action/render → interceptors after; filters receive admission
  and action errors. Note: Nest runs interceptors before pipes; the spec lists pipes
  first. We match Nest semantics (as the spec permits) and document it. Evidence:
  `tests/live-pipeline.test.ts`.
- **CORE-032** — Startup now also rejects host controller routes overlapping generated
  Live routes (exact, `:param` and wildcard; same method or `ALL`), naming the
  controller method, during module compilation so neither router registers an ambiguous
  route. Versioned host routes are skipped (documented). Evidence:
  `tests/live-pipeline.test.ts` (collision diagnostics), existing
  `tests/live-registration.test.ts`. Implementation: `packages/live/src/route-conflicts.ts`.
- **CORE-033** — Global middleware, global guards/interceptors/pipes/filters, nested
  hook ordering and cancellation (deadline abort, shutdown abort) are tested.
  Evidence: `tests/live-pipeline.test.ts`, `tests/live-action-options.test.ts`.
- **CORE-035** — Error codes: `NESTVEXA_ERROR_CODES` (core) and `LIVE_ERROR_CODES`
  (status + recovery per code; a source-scanning test fails if a code is emitted without
  being catalogued or with another status). Production-safe mapping: a thrown internal
  error becomes `500 Internal server error` with no message/stack/path; application
  `HttpException`s pass through filters. Evidence: `tests/live-protocol-contract.test.ts`,
  `tests/live-pipeline.test.ts`. Gaps: correlation ID on error bodies (success bodies
  echo `requestId`), configurable log redaction.
- **CORE-036** — Importing core and Live in a fresh Node process adds no globals (beyond
  tslib/undici internals of the Nest peers), no process listeners and no handles.
  Evidence: `tests/architecture-runtime.test.ts`.
- **CORE-040** — `NestvexaConfigService` input is validated with complete diagnostics
  (`NestvexaConfigError.issues`), never echoing values. Evidence: `tests/core-config.test.ts`.
- **CORE-042** — `LiveRuntime` is the Live action executor (admission, transaction,
  pipeline-integrated execution, error mapping); mapping documented in the protocol
  reference. No separate class was introduced.
- **CORE-046** — `FeatureCapabilityRegistry` distinguishes supported, degraded and
  unsupported, copies only declared fields and `report()`s a frozen snapshot.
  Evidence: `tests/core-config.test.ts`.
- **CORE-049** — Architecture test imports core (and Live) in a plain Node process and
  asserts no React/Vue/Svelte/Alpine/DOM/client modules resolve and core loads only core.
  Evidence: `tests/architecture-runtime.test.ts`.
- Not addressed: CORE-029 (decorator flags docs unchanged), CORE-031 (existing prefix
  tests only), CORE-034 (extension hook API), CORE-043 (request context factory),
  CORE-044/045 (renderer/assets), CORE-047/048 (security policy / diagnostics
  registries).

### Protocol (section 7.1–7.2, 7.5)

- **PROT-002** — Canonical versioned schemas published (`LIVE_REQUEST_SCHEMA`,
  `LIVE_RESPONSE_SCHEMA`, `LIVE_ERROR_SCHEMA`, JSON Schema 2020-12) in
  `packages/live/src/protocol-schema.ts`; golden fixtures; parser/schema lockstep test;
  seeded fuzzing (2,000 mutated envelopes must yield a frozen request or a
  `LiveProtocolError`); evolution guidance in the reference and ADR 0031. Evidence:
  `tests/live-protocol-contract.test.ts`. Note: schemas live in `protocol-schema.ts`
  next to `protocol.ts`, not a `protocol/` directory.
- **PROT-008** — Admission additionally validates the capability header
  (`400 INVALID_CAPABILITIES`) before guards/components. Evidence:
  `tests/live-action-options.test.ts`, `tests/live-renderless.test.ts`.
- **PROT-009 / PROT-010 / PROT-011** — DI resolution per request, Nest pipeline
  execution and the response envelope are covered by the pipeline and canonical suites;
  idempotency is now configurable per action (LIVE-007). Evidence:
  `tests/live-pipeline.test.ts`, `tests/live-action-options.test.ts`.
- **PROT-015 / PROT-016** — Envelopes, routes and every limit are documented with
  values and error codes. Evidence: `docs/reference/live-protocol.md`,
  `tests/live-protocol-contract.test.ts` (limits constant).
- **PROT-017** — Added request deduplication (idempotent replay keyed by identity,
  reference and request ID, fingerprinted payload), side-effect retry policy
  (non-idempotent duplicates fail 409; uncertain failures invalidate state) and
  concurrency model options. HMAC signing/key rotation stays N/A by design: state is
  server-stored behind an opaque reference (ADR 0002). Evidence:
  `tests/live-action-options.test.ts`, `tests/live-protocol-contract.test.ts`.
- **PROT-018** — All error statuses documented with recovery guidance; production
  bodies proven not to leak internals. Gap: asset-version mismatch is not implemented
  (needs a client header; protocol-major mismatch is `426`).
- **PROT-013 / PROT-020** — Partially: version mismatch (426), failure during render and
  tab concurrency are covered; network reorder/reconnection/memory-leak/browser suites
  were not extended here (browser runtime belongs to the client engineer).
- Not addressed: PROT-006/007/012 (browser runtime).

### Decorators, hooks and state (sections 7.3–7.4)

- **LIVE-003** — `@LiveComponent({ timeoutMs })` added and validated. `isolated` was
  not added: every component call is already its own Nest request and transaction
  (no server batching exists), so the option would be decorative; documented in
  ADR 0031's context.
- **LIVE-004** — `@State({ serializer })` (spec name, alias of `synthesizer`, mutually
  exclusive) and `@State({ default })` (JSON cloned per instance or factory; never
  overrides restored state or client updates) are implemented. Evidence:
  `tests/live-protocol-contract.test.ts`, `tests/live-action-options.test.ts`.
  Candidate **Done**.
- **LIVE-005** — `@Locked()` unchanged; locked writes are rejected (`422 STATE_LOCKED`)
  in existing `tests/live.test.ts` and new `tests/live-action-options.test.ts`.
- **LIVE-007** — `@Action({ idempotent, concurrency })` implemented (replay with
  `replayed: true`, `422 IDEMPOTENCY_CONFLICT`, `409 ACTION_BUSY` per identity across
  tabs; rejected requests keep their state). Single-process. Evidence:
  `tests/live-action-options.test.ts`, `tests/live-protocol-contract.test.ts`.
  Candidate **Done** (with the documented single-process limit).
- **LIVE-015** — Nested parent/child hook order is defined, documented and tested
  (exactly once each); hook/action deadlines with real cancellation
  (`liveAbortSignal`), plus shutdown abort. Evidence: `tests/live-pipeline.test.ts`,
  `tests/live-action-options.test.ts`, `docs/guides/live-lifecycle.md`. Remaining:
  no browser-unmount inference (by design, documented).
- **LIVE-017** — Typed synthesizers extended: `defineSynthesizer`, `enumSynthesizer`,
  `nullableSynthesizer`, `setSynthesizer`, `mapSynthesizer`; seeded property round
  trips for Date/BigInt/enum/nullable/Set/Map. Evidence:
  `tests/live-protocol-contract.test.ts`.
- **LIVE-018** — `Map`/`Set` now have trusted serializers (bounded, duplicate-rejecting,
  `__proto__` keys stored as data). Other clauses were already covered by
  `tests/live-protocol.test.ts`.
- **LIVE-019** — Writable synthesized fields are validated by the synthesizer (enum,
  nullable), so `string | null` fields work and out-of-domain values get
  `422 STATE_TYPE`. Evidence: `tests/live-action-options.test.ts`.
- **LIVE-022** — Never duplicating a payment/order action is proven: a replayed
  non-idempotent request fails `409 STALE_REVISION` and the action ran once; idempotent
  retries replay without re-executing. Evidence: `tests/live-action-options.test.ts`.
- **LIVE-023** — Multi-tab: identity-scoped concurrency proven across two mounted
  instances. Logout revocation and key rotation unchanged (existing tests).
- Not addressed: LIVE-012 (server-pushed events), LIVE-014 (optional decorators),
  LIVE-021.

### ARCH-010

Evaluated; Live intentionally depends on views only. Recorded in
`docs/adr/0030-live-kernel-boundary.md` and linked from the dependency graph. No
manifest change, so the docs graph check is unaffected.

## Behaviour changes to note at merge

- `x-nestvexa-capabilities` is now a token list: `renderless-v1, other-v1` negotiates
  renderless; malformed values (for example `RENDERLESS-V1`) are `400`. The bundled
  client sends exactly `renderless-v1`, which is unaffected.
- A host controller route overlapping a generated Live route now fails module
  compilation.
- `LiveRuntime.beforeApplicationShutdown` is now async and waits (≤ 10 s) for in-flight
  Live requests.

## Merge notes for the coordinator

- `packages/live/src/runtime.ts` edits are small and localized (admission capability
  parsing, `instance()` defaults, `operation()`/`hook()` deadline wrapping, replay/lock
  in `executeUntraced`, shutdown drain, synthesizer type-check bypass in
  `validatedUpdates`). Expect textual conflicts with the async-store work around
  `executeUntraced` and `validatedUpdates`; no store API was changed and `store.ts` was
  not edited.
- `packages/live/src/live.module.ts`: imports `DiscoveryModule` and adds
  `LiveRouteConflictCheck` to providers; the `MemoryLiveStore` instanceof check was not
  touched.
- Root `package.json`: new files added to `test:unit`, `test:integration`,
  `test:security`. No root Playwright entries (no new examples or browser specs).
- ADR numbers 0030 and 0031 were free on every branch at the time of writing.
- New tests listen on ephemeral ports (`listen(0)`), like the existing Live suites; the
  fixture origin uses port 3340 from the assigned range but never binds it.
