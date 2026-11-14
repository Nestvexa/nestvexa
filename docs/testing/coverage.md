# Coverage gates

`pnpm test:coverage` runs **every** Vitest file (`tests/**/*.test.ts`) with V8
coverage over **every package source file** (`packages/*/src/**`) and fails when
any of these thresholds is missed (ledger row QA-079, spec section 21.8):

| Scope                                                                                               | Statements | Branches | Functions | Lines |
| --------------------------------------------------------------------------------------------------- | ---------- | -------- | --------- | ----- |
| All gated sources together                                                                          | 85%        | 80%      | 85%       | 85%   |
| Each package (`packages/<name>/src/**`), checked separately                                         | 85%        | 80%      | 85%       | 85%   |
| Each high-risk file: Live protocol, state store, computed values, state context, core configuration | 85%        | **90%**  | 85%       | 85%   |

The per-package globs are generated from the `packages/` directory, so a new
package is gated from its first commit. No thresholds are lowered per file, and
there are no per-file overrides. The configuration is
[vitest.coverage.config.ts](../../vitest.coverage.config.ts).

## How sources are measured

The suites import the built `packages/*/dist/*.js` files (and examples import
`@nestvexa/*`). The coverage configuration adds a resolver plugin that redirects
every module resolving into `packages/<name>/dist/` to the matching
`packages/<name>/src/` file, for relative imports and `@nestvexa/*` specifiers
alike. Redirecting both keeps a single module instance per package, so Nest DI
tokens, decorator metadata registries and `instanceof` checks behave exactly as
in the normal run. Files with no source twin (the bundled client IIFE, CSS)
resolve unchanged.

Because of this redirect the coverage run is also a full test run against the
TypeScript sources. In CI the `ubuntu-latest` / Node 24 leg of
[ci.yml](../../.github/workflows/ci.yml) runs `pnpm test:coverage` instead of
`pnpm test`; the other three legs (Windows, Node 22) run `pnpm test` against the
built output, and `pnpm test:pack` and `pnpm test:e2e` exercise the packed and
served builds. The release matrix ([release.yml](../../.github/workflows/release.yml))
runs both on every leg.

Reports are written to `artifacts/reports/coverage/` (text summary, JSON,
JSON summary, HTML and LCOV) even when a threshold fails, and the test results
to `artifacts/reports/coverage-tests.json`.

## Exclusions

Only sources that cannot execute in Node are excluded. Each one runs in real
browsers, where V8 coverage in the Node process cannot see it; the reason and the
covering suite are recorded next to the glob in `browserOnlyExclusions` in the
configuration:

| Excluded source                                                                                                                                                    | Why it cannot run in Node                                                                         | Exercised by                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `client/src/{index,bindings,control-state,focus,form-reset,initialization,listeners,loading,models,morph,navigation,observers,presentation,sort,stream,upload}.ts` | Live browser runtime: DOM mounting, morphing, focus, observers, drag and drop, uploads, streaming | `tests/client-*.test.ts` in Chromium, Firefox and WebKit; Playwright specs |
| `offline/src/index.ts`                                                                                                                                             | Drafts, snapshots and the offline queue over DOM forms, Web Storage and BroadcastChannel          | `tests/offline-drafts`, `offline-snapshot`, `offline-queue-browsers`       |
| `ui/src/{browser/index,adapters/react,adapters/vue}.ts`                                                                                                            | UI kit browser behaviour and interactive React/Vue components                                     | `tests/ui-browser`, `ui-primitives-browser`, `ui-adapters`                 |
| `islands/src/{client,react,vue,svelte}.ts`                                                                                                                         | Island loader and client mount/hydrate adapters                                                   | `tests/islands-client`, hybrid Playwright specs                            |
| `{react,vue,svelte}/src/{client,boundary}.ts`                                                                                                                      | Inertia client boot (`createRoot`/`hydrateRoot`, mount/hydrate) and client error boundaries       | Inertia Playwright specs                                                   |
| `actions/src/client/element.ts`                                                                                                                                    | Binds forms and buttons through DOM attributes and bubbling events                                | `tests/actions-client-state` in Chromium                                   |
| `ai/src/browser/index.ts`                                                                                                                                          | Assistant panel glue bound to DOM elements                                                        | `tests/ai-browser` in Chromium                                             |

The pure modules of those packages stay gated: for example the client's
protocol, grammar, events, transport, realtime, URL-state, optimistic and
scheduler modules, the offline server queue, the UI markup modules, island
signing and server rendering, and the Inertia SSR entry points.

Coverage is a signal, not proof of behaviour. Excluded code is not untested; it
is tested where it runs.

## Measured result

Measured on 2026-11-14 on branch `r6-qa-gates` after merging `main` at `f3b96c0` (later main commits changed no package sources), on Windows
with Node 24.13.0, Vitest 5.0.5 and `@vitest/coverage-v8` 5.0.5. The suite ran
in twelve blob shards (`--shard=i/12 --reporter=blob`) merged with
`--merge-reports`, which yields the same coverage map as one run.

| Package               | Statements               | Branches                 | Functions             | Lines                    |
| --------------------- | ------------------------ | ------------------------ | --------------------- | ------------------------ |
| **All gated sources** | **91.59%** (21078/23012) | **86.05%** (17315/20120) | **95.2%** (3990/4191) | **93.63%** (19667/21004) |
| actions               | 88.8%                    | 82.1%                    | 97.9%                 | 90.6%                    |
| ai                    | 90.2%                    | 83.6%                    | 92.6%                 | 92.8%                    |
| alpine                | 96.7%                    | 94.2%                    | 100.0%                | 98.5%                    |
| cache                 | 95.8%                    | 95.0%                    | 100.0%                | 97.0%                    |
| cli                   | 90.2%                    | 80.7%                    | 96.3%                 | 92.7%                    |
| client                | 97.2%                    | 95.0%                    | 95.5%                 | 98.9%                    |
| core                  | 94.8%                    | 91.3%                    | 98.5%                 | 96.3%                    |
| engine-ejs            | 93.9%                    | 87.1%                    | 91.3%                 | 94.3%                    |
| engine-hbs            | 94.0%                    | 82.6%                    | 100.0%                | 96.5%                    |
| engine-nunjucks       | 96.5%                    | 89.7%                    | 95.5%                 | 98.1%                    |
| engine-pug            | 93.5%                    | 87.5%                    | 95.7%                 | 93.2%                    |
| flags                 | 88.4%                    | 84.7%                    | 100.0%                | 91.3%                    |
| forms                 | 90.8%                    | 85.5%                    | 97.2%                 | 93.4%                    |
| i18n                  | 87.2%                    | 81.6%                    | 91.9%                 | 89.0%                    |
| inertia               | 90.4%                    | 86.6%                    | 91.5%                 | 92.2%                    |
| islands               | 92.6%                    | 87.2%                    | 94.9%                 | 94.7%                    |
| live                  | 92.7%                    | 88.3%                    | 97.0%                 | 94.7%                    |
| mail                  | 94.7%                    | 86.9%                    | 100.0%                | 95.8%                    |
| nestvexa              | 90.2%                    | 88.0%                    | 98.8%                 | 91.8%                    |
| observability         | 93.7%                    | 84.7%                    | 91.6%                 | 94.8%                    |
| offline               | 96.4%                    | 92.7%                    | 100.0%                | 98.3%                    |
| react                 | 87.0%                    | 80.0%                    | 91.7%                 | 85.7%                    |
| realtime              | 88.9%                    | 81.8%                    | 92.1%                 | 92.6%                    |
| realtime-redis        | 91.7%                    | 84.9%                    | 92.5%                 | 94.7%                    |
| svelte                | 100.0%                   | 100.0%                   | 100.0%                | 100.0%                   |
| ui                    | 97.3%                    | 91.8%                    | 100.0%                | 97.6%                    |
| uploads               | 88.9%                    | 83.0%                    | 88.1%                 | 91.8%                    |
| views                 | 93.3%                    | 88.5%                    | 97.2%                 | 95.3%                    |
| vite                  | 94.1%                    | 90.9%                    | 99.0%                 | 95.4%                    |
| vue                   | 92.5%                    | 88.9%                    | 93.8%                 | 91.4%                    |

Every threshold passed: the aggregate, all 30 per-package globs and the five
high-risk files. The high-risk files measured:

| High-risk file              | Statements | Branches | Functions | Lines  |
| --------------------------- | ---------- | -------- | --------- | ------ |
| `live/src/protocol.ts`      | 99.18%     | 99.14%   | 100%      | 100%   |
| `live/src/store.ts`         | 100%       | 100%     | 100%      | 100%   |
| `live/src/computed.ts`      | 98.46%     | 94%      | 100%      | 98.3%  |
| `live/src/state-context.ts` | 97.71%     | 96.73%   | 100%      | 98.74% |
| `core/src/config.ts`        | 100%       | 98.37%   | 100%      | 100%   |

The lowest packages against the 80% branch threshold are `cli` (80.7%),
`react` (80.0%, 3 uncovered statements in total), `realtime` (81.8%),
`i18n` (81.6%) and `actions` (82.1%); they pass but have the least margin.

The run had 5168 tests in 241 files; the only failing file was
`tests/release-gate.test.ts`, whose fixture predated the flaky gate in
`release-check` and was fixed in the same branch. Before this round's
exclusions and tests, the same measurement gave statements 66.9%, branches
63.3%, functions 70.6% and lines 68.9% (most of the gap was browser-only code
and the SSR, island, uploader and bootstrap modules that had no Node tests).
Treat this table as a dated checkpoint; the JSON summary of the latest run is
the authority.

## Running it locally

```sh
pnpm build                 # browser suites and fixtures still load dist output
pnpm test:coverage         # every suite, all thresholds
```

The full run takes long on a small machine. To inspect one area, run the files
you care about with the same configuration; thresholds will fail because most
sources are not loaded, but the report under `artifacts/reports/coverage/`
shows the files you exercised:

```sh
pnpm exec vitest run --config vitest.coverage.config.ts --coverage tests/live-protocol.test.ts
```

To split a full run, use Vitest shards and merge them:

```sh
pnpm exec vitest run --config vitest.coverage.config.ts --coverage --shard=1/4 --reporter=blob
# ...shards 2 to 4...
pnpm exec vitest run --config vitest.coverage.config.ts --merge-reports --coverage
```

## Adding code

New source files are gated automatically. When a package drops below a
threshold, add behaviour tests that import from `packages/<name>/src` (or from
`dist`, which the coverage run redirects) for the uncovered branches; the
`*-source.test.ts` files are examples. Do not lower thresholds, add
`/* v8 ignore */` comments or extend the exclusion list for code that can run in
Node. A new browser-only module may be added to `browserOnlyExclusions` with its
reason and the browser suite that covers it, in the same pull request.

Mutation testing of the highest-risk modules runs nightly; see
[property, load and mutation testing](property-load-mutation.md).
