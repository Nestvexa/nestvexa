# QA gates, round 6

Branch `r6-qa-gates`, from main `6dba23e`, with main merged three times (last at
`f3b96c0`). Scope: the project-wide coverage gate (QA-079), flaky-test
gating (QA-081, QA-052), public API reports (QA-040, QA-049, QA-090) and the
nightly bench and mutation jobs (QA-089). Spec sections 18, 20, 21 and 26.

## QA-079: project-wide coverage gate

**Implemented.** [vitest.coverage.config.ts](../../../vitest.coverage.config.ts)
now runs every Vitest file (`tests/**/*.test.ts`) with V8 coverage over every
`packages/*/src/**` file, and enforces:

- all gated sources together: statements, functions and lines 85%, branches 80%;
- each package separately (globs generated from `packages/`, so new packages are
  gated automatically): the same 85/80/85/85;
- the five high-risk files (Live protocol, store, computed, state context, core
  configuration): 90% branches per file, as before.

A resolver plugin redirects every module that resolves into
`packages/<name>/dist/` (relative test imports and `@nestvexa/*` specifiers) to
the matching `src` file, so the suites measure the TypeScript sources while
keeping one module instance per package (Nest DI and metadata registries
unchanged). There are no per-file threshold overrides and no `v8 ignore`
comments.

Exclusions (`browserOnlyExclusions`, each with its reason and covering browser
suite in the config and in [docs/testing/coverage.md](../../testing/coverage.md)):
the DOM-bound client runtime modules, `offline/src/index.ts`, the UI kit browser
module and React/Vue adapters, the island loader and client mount adapters, the
React/Vue/Svelte Inertia client boot and error boundaries,
`actions/src/client/element.ts` and `ai/src/browser/index.ts`. The pure modules
of those packages stay gated.

New source-level tests written to close real gaps (all in `test:unit` unless
noted):

| File                                                    | Covers                                                                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/core-config-scopes-source.test.ts`               | `views.namespaces` / `views.themes` validation in `core/src/config.ts` (the round 5 branches that dropped main's high-risk gate to 79.67%); with `high-risk-source` the file reaches 95.93% branches |
| `tests/client-transport-source.test.ts`                 | Live fetch boundary: protocol negotiation, HTTP hints, content type and size limits, invalid bodies, network errors, timeout, abort                                                                  |
| `tests/client-pure-source.test.ts`                      | confirmation controller lifecycle, `readPath`, Trusted Types policy, event names, title/download effects, URL state writes                                                                           |
| `tests/inertia-ssr-source.test.ts`                      | React/Vue SSR through the official Inertia server paths, Svelte with an injected `createInertiaApp`, server factory defaults                                                                         |
| `tests/islands-server-source.test.ts`                   | server island context, React and Vue island renderers                                                                                                                                                |
| `tests/observability-source.test.ts`                    | dev error page (template locations, editor links, root containment, escaping, filter deferral) and `traceGuard`                                                                                      |
| `tests/uploads-browser-source.test.ts`                  | browser uploader protocol against a scripted XMLHttpRequest double (digests, retries, direct mode, cleanup, cancellation)                                                                            |
| `tests/alpine-bootstrap-source.test.ts`                 | `startLiveAlpine` / `adoptLiveAlpine` document ownership and failure paths                                                                                                                           |
| `tests/actions-cli-source.test.ts` (`test:integration`) | `nestvexa-actions-codegen` in-process: arguments, generation, `--check`, diagnostics                                                                                                                 |

CI: the `ubuntu-latest` / Node 24 leg of `ci.yml` runs `pnpm test:coverage`
in place of `pnpm test` (the coverage run is a full run against sources); the
other three legs run `pnpm test`. `release.yml` runs both on every leg.

**Measured** (2026-11-14, branch merged with main `f3b96c0`; main `a3ebbc0`
changed no package sources; Windows, Node 24.13.0, Vitest and
`@vitest/coverage-v8` 5.0.5; all 241 test files in 12 merged blob shards):

| Scope                            | Statements           | Branches                                                          | Functions         | Lines                |
| -------------------------------- | -------------------- | ----------------------------------------------------------------- | ----------------- | -------------------- |
| All gated sources                | 91.59% (21078/23012) | 86.05% (17315/20120)                                              | 95.2% (3990/4191) | 93.63% (19667/21004) |
| Lowest package margins           | cli 90.2%            | react 80.0%, cli 80.7%, i18n 81.6%, realtime 81.8%, actions 82.1% | uploads 88.1%     | react 85.7%          |
| `core/src/config.ts` (high risk) | 100%                 | 98.37%                                                            | 100%              | 100%                 |

Every threshold passed: aggregate, all 30 packages and the five high-risk files
(lowest high-risk branch figure: `live/src/computed.ts` 94%). Per-package table
in [docs/testing/coverage.md](../../testing/coverage.md#measured-result). The
only failing file in that run was `tests/release-gate.test.ts` (its fixture did
not know about the new flaky condition); fixed in `b1f020f` and rerun green.
Before this round's exclusions and tests the same measurement was statements
66.9%, branches 63.3%, functions 70.6%, lines 68.9%.

Main's current failure (`core/src/config.ts` branches 79.67% under the old
seven-file gate) does not occur with this configuration: every suite now counts
toward that file, and `tests/core-config-scopes-source.test.ts` covers the
namespace/theme branches. The coordinator said a `tests/core-config-views-source.test.ts`
is being added on main for the same branches; when both land, one of the two
files can be dropped.

Known gaps: the measurement was taken locally, not on a CI runner; the first
full runs on this loaded machine had timeouts in browser-driven suites
(`client-directive-combinations` in Firefox/WebKit, several Nest integration
files), all of which passed when rerun alone under the coverage configuration.
The Svelte island server renderer (`islands/src/svelte-server.ts`, 2 statements)
has no Node test because it needs a server-compiled Svelte component.

## QA-081 / QA-052: flaky outcomes

**Implemented.** [scripts/flaky-check.mjs](../../../scripts/flaky-check.mjs)
reads `artifacts/reports/playwright.json`, lists every test whose outcome is
`flaky` (project, file:line, title, attempts, first failure line) and uses the
larger of that list and `stats.flaky`. It writes `artifacts/reports/flaky.json`,
GitHub annotations and a job-summary table.

Policy ([docs/testing/flaky-tests.md](../../testing/flaky-tests.md)): pull
requests and pushes report flakes without failing (`--mode=report` after
`test:e2e` in `ci.yml`); nightly e2e (per engine), every release matrix leg
(`--mode=block`) and `pnpm release:check` fail on any flake. No quarantine list;
retries stay at 2 on CI. `release-check.mjs` now also requires
`stats.flaky === 0` and names each flaky test as a blocker. `pnpm flaky:check`
runs block mode locally.

Tests: `tests/quality-gates.test.ts` (flaky list, both modes, stats fallback,
malformed reports, markdown escaping).

## QA-040 / QA-049 / QA-090: public API reports

**Implemented** (the API extraction part of QA-040; the import-cycle,
duplicate-dependency and type-test parts of QA-040 remain open).
[scripts/api-report.mjs](../../../scripts/api-report.mjs) uses the workspace
TypeScript compiler (no new dependency; `@microsoft/api-extractor` 7.60.1 was
checked and not needed) over each published package's `exports` typings. Per
entry point it prints every exported declaration (comments removed, names
sorted), workspace and third-party re-exports as one-liners, and a "Referenced
but not exported" section for package-local declarations used by public
signatures. Output is LF and path-independent.

- Reports: [api-reports/](../../../api-reports/) (30 packages), ignored by
  Prettier because they are compared byte for byte.
- `pnpm api:check` (CI on every `ci.yml` and `release.yml` leg, and in
  `test:all`) fails with a line diff; `pnpm api:update` rewrites the reports.
- Docs: [docs/contributing/api-reports.md](../../contributing/api-reports.md)
  (update flow and the changeset bump per kind of change), linked from the
  release process and ADR 0008.
- Tests: `tests/quality-gates.test.ts` (entry discovery, sorting, forgotten
  declarations, doc-only edits ignored, signature/removal/private-interface
  changes detected, CRLF checkouts, stale reports, unbuilt typings).

Remaining for QA-090: the Nest-major matrix dimension, a recorded
release-candidate run and the owner-supplied security review evidence are
unchanged.

## QA-089: nightly bench and mutation

`nightly.yml` keeps the `mutation` job (uploads `artifacts/reports/mutation/`).
Main added a `bench` job in parallel to this round; on merge I kept main's job
and dropped my duplicate. The nightly e2e jobs now fail on flaky outcomes. The
chaos job and optional-package permutations named in the ledger are not part of
this round.

## Verification

Run in the worktree (Windows, Node 24.13.0), one file or a few at a time
except for the sharded coverage run:

| Command                                                                                                                                                                         | Result                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` and `pnpm build` (after each main merge)                                                                                                       | passed                                                                                                                 |
| `pnpm exec vitest run --config vitest.coverage.config.ts --coverage --shard=i/12 --reporter=blob` (12 shards) then `--merge-reports --coverage`                                 | all thresholds passed; 5152/5168 tests passed, the 16 failures were all `tests/release-gate.test.ts`, fixed afterwards |
| `pnpm exec vitest run tests/release-gate.test.ts`                                                                                                                               | 23 passed                                                                                                              |
| `pnpm exec vitest run tests/quality-gates.test.ts`                                                                                                                              | 19 passed                                                                                                              |
| `pnpm exec vitest run` on each new `*-source.test.ts` file                                                                                                                      | all passed (29, 40, 10, 4, 29, 26, 14, 51 and 10 tests)                                                                |
| Previously timing-out files rerun under the coverage config (`actions-jobs`, `live-lifecycle-hooks`, `live-pipeline`, `realtime-hub`, `realtime-jobs`, `cli-generators`, `cli`) | 122 passed                                                                                                             |
| `node scripts/api-report.mjs`                                                                                                                                                   | matches the built typings (30 packages)                                                                                |
| `pnpm lint`                                                                                                                                                                     | passed                                                                                                                 |
| `pnpm exec tsc -p tsconfig.tests.json --noEmit`                                                                                                                                 | passed                                                                                                                 |
| `pnpm exec prettier --check` on changed files                                                                                                                                   | passed                                                                                                                 |

Not run: the root `pnpm test:e2e` and `playwright.config.ts` (brief), so the
flaky check has not seen a real CI report with retries; a GitHub Actions run of
the changed workflows.

## Notes for the coordinator

- `package.json`: new scripts `api:check`, `api:update`, `flaky:check`;
  `test:all` gains `api:check` and `flaky:check`; nine new files in `test:unit`
  and `tests/actions-cli-source.test.ts` in `test:integration`.
- `ci.yml` changes are additive inside `foundation` (new `api:check` and flaky
  report steps; the `pnpm test` / `pnpm test:coverage` steps are split by leg).
  The `ledger` and `pr-policy` jobs are untouched.
- Any later merge that changes public typings must run `pnpm build &&
pnpm api:update` and commit `api-reports/`, or `api:check` fails in CI.
- `.prettierignore` gains `api-reports`; `.gitignore` gains `.vitest-reports/`.
