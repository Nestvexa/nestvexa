# Test matrix

Every gate is a root `package.json` script. CI ([ci.yml](../../.github/workflows/ci.yml))
runs the `foundation` job on **ubuntu-latest and windows-latest × Node 22 and 24** with
`fail-fast: false`, then uploads `artifacts/` as evidence.

## Commands

| Command                         | What it proves                                                                                               | CI (`ci.yml`)  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------- |
| `pnpm format:check`             | Prettier formatting of the whole repository                                                                  | yes            |
| `pnpm lint`                     | ESLint (no `any`, no non-null assertions, no ts-comments) and [boundary rules](../../scripts/boundaries.mjs) | yes            |
| `pnpm typecheck`                | Builds every package, then compiles tests and configs strictly (`tsconfig.tests.json`)                       | yes            |
| `pnpm test`                     | All Vitest files: unit, real Nest integration over HTTP, security corpora, Chromium-driven DOM suites        | yes            |
| `pnpm test:unit`                | Pure logic: protocol parsing, client bindings, adapters, codegen                                             | via `test`     |
| `pnpm test:integration`         | Real Nest apps (Express and Fastify) over HTTP, lifecycle, CLI end to end                                    | via `test`     |
| `pnpm test:security`            | Negative and attack-corpus cases (origin, CSRF, ownership, replay, injection, size limits)                   | via `test`     |
| `pnpm test:contracts`           | Package entry points and non-browser core import                                                             | via `test`     |
| `pnpm test:coverage`            | Vitest with V8 coverage ([coverage policy](../testing/coverage.md))                                          | yes            |
| `pnpm size:check`               | Production client bundle within the 48 KiB gzip budget ([ADR 0020](../adr/0020-client-budget-revision.md))   | yes            |
| `pnpm test:e2e`                 | Playwright against the example servers in Chromium, Firefox and WebKit, including axe accessibility checks   | yes            |
| `pnpm test:accessibility`       | Playwright tests tagged `accessibility`                                                                      | via `test:e2e` |
| `pnpm test:pack`                | Packs all 28 tarballs, inspects contents, installs them into external npm/pnpm consumers and boots them      | yes            |
| `pnpm docs:build`               | Docs structure, links, anchors, snippet provenance, CLI and graph drift; builds the site and API reference   | yes            |
| `pnpm ledger:check`             | The feature ledger is internally consistent                                                                  | no             |
| `pnpm bench`                    | Reproducible micro-benchmarks written to `artifacts/reports`                                                 | no             |
| `pnpm test:services`            | Real Redis (two processes, restart), S3-compatible storage and clamd, when env vars are set                  | no             |
| `pnpm test:node22` / `:node24`  | Strict compile and the aggregate suite under pinned Node 22.23.4 / 24.22.1 binaries                          | no             |
| `pnpm test:compat`              | Build, integration suite and pack                                                                            | no             |
| `pnpm audit --audit-level high` | No high or critical advisories ([security.yml](../../.github/workflows/security.yml) runs it weekly)         | weekly         |
| `pnpm release:check`            | Release gate: every phase Done and every evidence report green. **Fails by design** while work remains       | no             |
| `pnpm checkpoint:check`         | Runs install, format, lint, typecheck, test, coverage, size, e2e, pack, docs, ledger, bench, audit, release  | no             |
| `pnpm test:all`                 | The full sequence used by the owner release review ([release.yml](../../.github/workflows/release.yml))      | manual         |

## Where tests live

| Path                      | Kind                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `tests/*.test.ts`         | Vitest: unit, integration (real Nest + HTTP) and security suites     |
| `tests/browser/*.spec.ts` | Playwright specs against example servers                             |
| `tests/pack-consumers/`   | External consumer apps installed from tarballs by `pnpm test:pack`   |
| `tests/fixtures/`         | Shared fixtures ([browser fixtures](../testing/browser-fixtures.md)) |

Every test file must belong to a group script so it runs in a named gate. A file that
starts a browser belongs to `test:integration` or `test:security`, not `test:unit`.

## Not covered yet

> **Known gap:** load, soak, memory, fuzz and mutation testing are not part of any gate.
> No manual assistive-technology review has been done. No test runs two Nest replicas
> serving one browser through Redis. No external links in the docs are checked. Node 26
> and macOS are untested ([status](../implementation/STATUS.md)).

For how to test your own application, see the [testing guide](../testing/guide.md).
