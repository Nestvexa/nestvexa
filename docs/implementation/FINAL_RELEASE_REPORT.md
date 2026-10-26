# Release checkpoint report — 2026-10-26

**A. Status: NOT YET READY — BLOCKERS.** This is an interim report, not Phase 17 acceptance. The [925-unit ledger](feature-ledger.md) records **82 InProgress, 843 Pending and 0 Done**. No complete phase is accepted. The implemented model checkpoint and isolated-runtime reruns passed; mandatory master scope, matrix and review gates remain open.

## B. What exists

Seven packages contain source, public types and READMEs: [core](../../packages/core/README.md), [views](../../packages/views/README.md), [engine-hbs](../../packages/engine-hbs/README.md), [nestvexa](../../packages/nestvexa/README.md), [live](../../packages/live/README.md), [client](../../packages/client/README.md) and [alpine](../../packages/alpine/README.md). The [HBS starter](../../examples/starter-hbs/README.md) and [cookie-backed Live counter](../../examples/live-counter/README.md) run on real Nest servers.

Live has generated Nest routes, bounded JSON/state tokens, host identity/CSRF/origin/authorization, revision checks and application-local registration ownership. Duplicate component types/names/routes reject startup consistently. Disjoint modules mount through their owning policy/store/renderer and reuse request context IDs without bypassing exports. Shutdown guards prevent late state creation. Renderer lifecycle is explicitly host-owned. Client event modifiers, keyboard filters, timer cleanup and isolated Alpine work to their [documented limits](../reference/directives.md). Automatic umbrella HBS/Live/Alpine bootstrap remains unmet.

The model slice adds deferred/live/blur/change/lazy modes, finite decimal and explicit boolean casts, bounded debounce/leading throttle, native single-select/radio values, IME handling and cleanup. Invalid local conversion blocks requests. The fixed `_sync` route requires explicit `$sync` authorization and component/global Nest policies; action-method guards do not apply and no action or action hooks run. Pure writable-state validators can return422 before component execution while preserving the snapshot for correction; transaction revision checks still reject conflicting writes. Full model/forms acceptance remains open.

Observed versions: Windows host Node 24.13.0, additional Node 22.23.4 and 24.22.1, pnpm 10.26.1, Nest 12.2.0, TypeScript 6.0.3, Handlebars 4.7.10, Vitest 5.0.5, Playwright 1.64.1, express-session 1.19.0, Alpine CSP 3.17.5 and axe Playwright 4.14.0. See [compatibility](../architecture/upstream-compatibility.md).

## C. Evidence

The [model checkpoint summary](model-checkpoint-evidence-2026-10-26.json) preserves the successful combined runner at **2026-10-26T20:22:16.515Z** on Windows/Node 24.13.0. All implemented-checkpoint commands exited 0; `release:check` correctly exited 1 because mandatory scope/review/matrix gates remain open. The pack result timestamp is **2026-10-26T20:23:42.043Z**. Isolated Node **22.23.4 and 24.22.1 each passed strict compilation and 379 aggregate tests** after the test-fixture transport correction described below.

| Current model command/report                      | Observed result and scope                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, typecheck/build | All exited 0 in the combined model checkpoint                                                                                                                           |
| `pnpm test`                                       | **379/379 passed**, including native-control/model scheduler, synchronization policy/validation and registration regressions                                            |
| `pnpm test:coverage`                              | **97.18% branches, 98.20% statements** across only config, Live protocol and memory store; excludes runtime/action/client and most project files                        |
| `pnpm test:e2e`                                   | **48 expected, 0 unexpected/skipped/flaky**, Chromium/Firefox/WebKit with 2 workers, including fixture keyboard/axe/CSP checks                                          |
| `pnpm test:pack`                                  | Seven tarballs inspected; successful npm and pnpm external strict compilation, real MVC/Live DI/guard/pipe/replay and Node-safe import consumers                        |
| Isolated runtimes                                 | Node 22.23.4 and 24.22.1 each passed strict compilation and all 379 aggregate tests; full three-browser server/consumer matrices were not repeated under these binaries |
| `pnpm size:check`                                 | **66,354 raw bytes, 17,828 summed per-module gzip bytes across 9 modules**, below 35KiB gzip budget excluding Alpine/maps; not measured HTTP transfer                   |
| Docs, ledger, HBS microbenchmark, audit           | All exited 0; audit reported no known vulnerabilities, docs/ledger do not imply product acceptance, benchmark is not an application comparison                          |
| `pnpm release:check`                              | Correctly exited 1; mandatory master scope, matrix and independent review remain incomplete                                                                             |

The [registration checkpoint summary](registration-checkpoint-evidence-2026-10-26.json) preserves the earlier full runner at **2026-10-26T14:14:12.280Z**. Historical [foundation](checkpoint-evidence-2026-10-26.json) and [event](event-checkpoint-evidence-2026-10-26.json) snapshots remain distinct. The following table retains the historical registration checkpoint for comparison; it is not the current model result.

| Command/report                                    | Observed result and scope                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, typecheck/build | All exited 0 in the registration runner                                                                                                                                            |
| pnpm test                                         | **249/249 passed**, including 14 Express/Fastify registration/context/shutdown regressions                                                                                         |
| pnpm test:coverage                                | 74 tests; **97.18% branches, 98.20% statements** across only config, Live protocol and memory store; registration/runtime and most project files are outside this measurement      |
| pnpm test:e2e                                     | **36 expected, 0 unexpected/skipped/flaky** across Chromium, Firefox and WebKit; fixture keyboard/axe/CSP checks passed                                                            |
| pnpm test:pack                                    | Seven tarballs inspected; npm and pnpm external consumers strict-compiled declarations and exercised real MVC/Live DI/guards/pipes/replay plus Node-safe imports                   |
| Additional runtimes                               | Windows Node 22.23.4 and 24.22.1 each passed strict compilation and the 249-test aggregate; this does not repeat the complete three-browser web-server matrix under those binaries |
| pnpm size:check                                   | 49,839 emitted custom-client bytes; 13,388 summed per-module gzip bytes versus 35KiB budget, excluding Alpine/maps; not measured HTTP transfer                                     |
| Docs and ledger                                   | Linked documentation snapshots and bookkeeping integrity passed; neither accepts the whole product                                                                                 |
| Benchmark                                         | 1,000 cached-HBS adapter iterations; no comparative application/load claim                                                                                                         |
| Dependency audit                                  | Exited 0 with no known vulnerabilities; consumers still need patched Multer resolution until upstream updates                                                                      |
| Release check                                     | Correctly exited 1: full master phases/requirements, matrix and review evidence remain incomplete                                                                                  |

An earlier registration runner stopped after a Windows Playwright trace-file EBUSY teardown failure during concurrent activity: 35 browser passes and one failure. The complete sequential rerun passed. No tests or accessibility rules were excluded. Fixture checks do not certify universal accessibility, independent security review or absence of undiscovered bugs.

Earlier model attempts also retain failures: one reached 47/48 browser passes before a WebKit throttle fixture raced automation IPC; another reached 46/48 passes before a Firefox page-fixture timeout and a WebKit in-flight assertion raced a real 200ms action. The throttle fixture now dispatches within one browser event turn, and in-flight assertions gate the actual server response instead of assuming a short timing window. Browser workers are 2. The complete combined runner subsequently passed; no real action/response was replaced with a fabricated success.

An earlier isolated Node 24.22.1 run reached 378/379 aggregate passes when fetch rejected an OS-assigned reserved ephemeral port in the Fastify shutdown fixture. The request rejection also caused a 15-second fixture admission wait timeout and unhandled rejection. This test-transport/cleanup failure did not establish a product defect. The test now uses a real node:http request with fail-fast gate waits and guaranteed cleanup; fresh host checkpoint and isolated Node 22/24 compilation/aggregate checks subsequently passed.

## D. Documentation

Root [README](../../README.md), every package README, ten ADRs, architecture records, [Live protocol](../guides/live-protocol.md), [hardening](../security/hardening.md), partial [ASVS mapping](../security/asvs-traceability.md), preliminary [security review](../security/security-design-review.md), community policies and [changelog](../../CHANGELOG.md) exist. The production docs website and guides for undelivered systems remain required work.

## E. Artifacts

Version 0.1.0-alpha.0 tarballs are under artifacts/packages. The current pack report and tracked model summary contain all seven package names, SHA-256 values, archive inventories and successful npm/pnpm consumer commands. Both new client model modules are present in the client archive. Reports/logs are under artifacts/reports; readable docs snapshots under artifacts/docs. No publication, SBOM, provenance attestation or approved release manifest is claimed.

## F. Known issues and unmet gates

Full Live behavior, forms/uploads, alternative engines, official Inertia React/Vue/Svelte integrations, hybrid islands, universal actions, realtime/distributed stores/cache/jobs, extensions, CLI and automatic default bootstrap remain unmet. Linux is unverified because the local Docker daemon is unavailable. Full Nest/platform/browser/fault matrices, project-wide coverage, mutation/fuzz/long-memory/load tests and independent review remain open.

Memory state/sample sessions are single-process without durable exactly-once business guarantees. Hosts own authentication, principal/tenant selection, logout revocation, body limits, production sessions, renderer lifecycle, TLS/proxy policy and business transactions. Synchronization is a separate write surface: policies required for every edit must use `$sync` authorization or component/global scope, rather than an action-method guard. Nested paths, multiple selects and file/array models remain unsupported.

## G. Owner release steps

After all gates pass: verify package/scope ownership, trademark/license review, official repository/maintainer/private security contacts and protected trusted-publishing controls; approve version/tag; review artifacts/security evidence; explicitly authorize publication. No remote push, namespace reservation or npm publication occurred.

## H. Maintenance

The unreleased version is 0.1.0-alpha.0. Public changes need tests, docs, a Changeset and migration review. Local commits 2bb6274, 25b45d0 and 53eb436 preserve the foundation, event and registration slices; model work has tracked checkpoint evidence. Finish mandatory implementation and adopt supported release/security windows before public distribution.
