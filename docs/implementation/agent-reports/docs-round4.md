# Agent report: docs refresh and package hygiene, round 4

Branch `worktree-agent-af7b540d529d051b5`, based on `main` at `8fe5afd`. It changes
documentation, ADRs and `package.json` metadata and scripts only. No source, test
or dependency changed, and `pnpm-lock.yaml` is untouched.

Method: each claim was read against the package source, its tests and the package
README, and then fixed. Nothing was marked shipped without a test that exercises it.
Accepted ADR decisions were not rewritten. Changes are dated **Amendment** or
**Status update** sections, plus an updated status line that points to them.

## Per ledger row

### ARCH-005, ARCH-020: package scripts and maintainers

- Every one of the 30 packages now has a `test` script of the form
  `vitest run --root ../.. <filters>`, which runs that package's own suites from the
  root Vitest config. Eleven packages had none: ai, cache, cli, flags, i18n, islands,
  mail, observability, offline, realtime and ui. The existing scripts that listed
  `../../tests/*.ts` paths were normalized to the same form, and the filters were
  widened to cover the suites added since. Each filter set was checked against the
  `tests/**/*.test.ts` file list, for example `actions` → 8 files, `client` → 37,
  `live` → 28.
- Every `package.json` declares
  `"maintainers": [{ "name": "Nestvexa", "url": "https://github.com/Nestvexa" }]`.
  No people are named.
- Every package README has a **Maintainers** section that points to
  `.github/CODEOWNERS` and `GOVERNANCE.md`. `.github/CODEOWNERS` already existed and
  is unchanged, so no `@Nestvexa` team placeholder was needed.
- Evidence: `pnpm --filter @nestvexa/cache test` (1 file, 4 tests) and
  `pnpm --filter @nestvexa/flags test` (2 files, 24 tests) pass.
  `tests/contracts.test.ts` passes (3 tests).
- Gap: the scripts need the package and its dependencies built first, because the
  tests import `dist`. Each README's Testing section says so.

### MISSION-022, MISSION-024, DOC-022: package READMEs, getting started, README

- All 30 package READMEs: the Install section states that nothing is published and
  shows the tarball path. Each README has a **Status and limits** section whose
  status word and gaps were checked against the code and tests. Testing sections use
  the package `test` script. Sub-agents audited these READMEs, and this agent
  re-checked the status lines.
- Further corrections in this round:
  - `@nestvexa/react`, `vue` and `svelte`: typed action hooks, composables and
    stores come from `@nestvexa/actions` codegen (`createActionHooks`,
    `createActionComposables`, `createActionStores`). The adapters do not ship
    them. The old "no typed hooks yet" wording was wrong.
- The root `README.md`:
  - Known limitations replaced. The old list (no Redis store, no Precognition, no
    typed hooks, no island SSR, no CLI scaffolding, 15 packages without `default`)
    was all closed. The new list is single Redis primary, process-local action
    stores, GraphQL coexistence untested, `shareOnce` and error-page helpers, UI
    chart and form-field wrappers, the offline queue, and ADR 0035.
  - The Verification section records that the Linux checkpoint and the real-service
    suite have passed (STATUS.md) and documents the per-package `test` scripts.
  - The Project section names the maintainer declaration.
- Getting started:
  - `README.md`: the CLI scaffolds every renderer on Express and Fastify.
  - `api.md`: `202` jobs, tracing and framework hooks exist; streaming does not.
  - `inertia.md`: client-owned features are browser-verified in
    `tests/browser/inertia-react-features.spec.ts`.
  - `live.md`: the Redis store, action options and serializers exist.
  - `mvc.md`: the umbrella `views` config takes only four keys, and helpers and
    error pages come from `@nestvexa/views`.
  - `hybrid.md`: see below.
- Also corrected:
  - `docs/tutorials/crud-app.md` and `deploy.md`.
  - `docs/migration/from-livewire.md` and `from-inertia-laravel.md`.
  - `docs/deployment/multi-replica-redis.md`. It said that Live state cannot be
    shared, that no two-replica run had happened and that presence and publish
    limits were missing. It now documents `RedisLiveStore` and the 2026-11-05
    services run.
  - `ROADMAP.md`: shipped items removed and the remaining ones listed.
- `docs/feature-matrix.md` was re-checked row by row against the READMEs and tests.
  - Changed to Shipped (alpha): Precognition, islands, actions, uploads, i18n, the
    Redis broker and store, and realtime-redis. `core`, `views`, `vite` and
    `islands` package rows now match their README status.
  - Rows changed: Alpine (`dispatch`/`on` exist, `state`/`entangle` deliberately
    absent), forms, UI wrappers, the plugin registry (now Partial) and recipes.
  - A new "By design" status covers the ADR 0035 row.
  - The "Nothing here is release-ready" note no longer says the two-replica run is
    missing.
  - Ledger counts were left as recorded in `feature-ledger.json`, with a note that
    the ledger lags the code.

### LIVE-003, LIVE-014: ADR 0035

- New [ADR 0035](../../adr/0035-live-layout-isolation-and-transitions.md). It
  records why `@LiveComponent` has no `layout` or `isolated` option and Live has no
  `@Layout` or `@Transition`. Host routes own layouts. Every component is its own
  Nest request, so it is already isolated. Transitions use `nv:transition`. The ADR
  has rejected alternatives, trade-offs and cost, failure modes and compatibility,
  and evidence. It is listed in `docs/adr/README.md`, and `packages/live/README.md`
  already links it.
- Gap: `tests/live-optional-decorators.test.ts` still says "see
  packages/live/README.md" in its header comment. Test files were out of scope.

### UPSTREAM-002/011/014–023, ARCH-016: ADRs and architecture

- ADR 0001, 0003 and 0006 gain **Trade-offs and cost** and **Failure modes**
  sections and a dated 2026-11-07 amendment:
  - 0001: the shape of the 30 packages, the `default` condition enforced by
    `tests/contracts.test.ts`, the umbrella's dependencies, and owner review still
    pending.
  - 0003: Live and server actions run through generated Nest controllers, and the
    pipeline order is tested in `tests/actions-http.test.ts` on Express and Fastify.
    Non-HTTP transports remain open.
  - 0006: "no mutation endpoint" is no longer true. The amendment lists the
    fail-closed checks and the negative suites per package, and notes that the
    internal review is not independent.
- Dated status updates for decisions whose open items closed:
  - 0002: distributed store, protocol evolution. Signed snapshots are still not
    implemented.
  - 0004: islands and Inertia ship. Heterogeneous navigation remains open.
  - 0005: model implemented, plus idempotency and concurrency.
  - 0010: observability package and OTel bridge.
  - 0013: lazy components.
  - 0018: Phase 9–11 shipped.
  - 0019: hooks and jobs shipped. Streaming and shared stores remain open.
- `docs/architecture/overview.md`:
  - The Live state section now describes `RedisLiveStore`. The old gap said there
    was no Redis store. The new gap is single primary and LIVE-007.
  - The extensibility table lists `RedisLiveStore`.
  - The plugin gap describes the `PluginRegistry` that exists.
- `docs/architecture/package-dependency-graph.md`: refreshed for 30 packages. The
  "only 14 packages carry `default`" gap is replaced by the enforced rule plus two
  limits: the `@nestvexa/ui/svelte` source entry is for bundlers, and CommonJS is
  exercised by the CLI end-to-end test. `@nestvexa/mail` was already a node, a
  table row and a feature matrix row.
- `docs/getting-started/hybrid.md`: the stale gap (no SSR, signed props or budgets,
  and no Vite path) is replaced by a "Building islands with Vite" section that
  links `examples/islands-vite` and its spec. The remaining limits come from the
  islands README.
- Gap: ADR 0008 (compatibility matrix) and ADR 0014/0017 status lines were not
  re-verified in this round.

## Not done

- The ledger, `STATUS.md`, `progress.json` and `FINAL_RELEASE_REPORT.md` were not
  edited, as instructed. Several `outstandingIssues` in `feature-ledger.json` are now
  stale against the code, so the coordinator should re-check them:
  - SPA-003 and ACT-014: codegen emits React, Vue and Svelte hooks.
  - INERT-007: Precognition ships.
  - ISLAND-004: manifest, SSR and the interaction strategy ship.
  - DATA-020: explicit hydration ships.
  - FORM-005: `FormValidationPipe` with `@ActionInput`.
  - UP-008: SPA browser uploader.
  - BROW-014: `dispatch`/`on` exist, and `state`/`entangle` are by design.
- `docs/guides/*` were searched for stale gap statements. Only those listed above
  were found and fixed; the guides were not re-read in full.
- The "As of 2026-11-05 … not on the npm registry" statements were kept. The
  registry was not re-queried.

## Verification

Run in the worktree:

- `pnpm exec prettier --check` on every changed file: clean.
- `pnpm docs:build`: see the final message for the result.
- `pnpm exec vitest run tests/contracts.test.ts`: 3 passed.
- `pnpm --filter @nestvexa/cache test` and `pnpm --filter @nestvexa/flags test`:
  pass.
- `pnpm lint` and `pnpm exec tsc -p tsconfig.tests.json --noEmit`: see the final
  message.
