# Release checkpoint report — 2026-10-26

**A. Status: NOT YET READY — BLOCKERS.** This is an interim report, not Phase 17 acceptance. The [925-unit ledger](feature-ledger.md) records **81 InProgress, 844 Pending and 0 Done**. No complete phase is accepted.

## B. What exists

Seven packages contain source, public types and READMEs: [core](../../packages/core/README.md), [views](../../packages/views/README.md), [engine-hbs](../../packages/engine-hbs/README.md), [nestvexa](../../packages/nestvexa/README.md), [live](../../packages/live/README.md), [client](../../packages/client/README.md) and [alpine](../../packages/alpine/README.md). The [HBS starter](../../examples/starter-hbs/README.md) and [cookie-backed Live counter](../../examples/live-counter/README.md) run on real Nest servers.

Live has generated Nest routes, bounded JSON/state tokens, host identity/CSRF/origin/authorization, revision checks and application-local registration ownership. Duplicate component types/names/routes reject startup consistently. Disjoint modules mount through their owning policy/store/renderer and reuse request context IDs without bypassing exports. Shutdown guards prevent late state creation. Renderer lifecycle is explicitly host-owned. Client event modifiers, keyboard filters, timer cleanup and isolated Alpine work to their [documented limits](../reference/directives.md). Automatic umbrella HBS/Live/Alpine bootstrap remains unmet.

Observed versions: Windows host Node 24.13.0, additional Node 22.23.4 and 24.22.1, pnpm 10.26.1, Nest 12.2.0, TypeScript 6.0.3, Handlebars 4.7.10, Vitest 5.0.5, Playwright 1.64.1, express-session 1.19.0, Alpine CSP 3.17.5 and axe Playwright 4.14.0. See [compatibility](../architecture/upstream-compatibility.md).

## C. Evidence

The [registration checkpoint summary](registration-checkpoint-evidence-2026-10-26.json) preserves the full runner at **2026-10-26T14:14:12.280Z**. Historical [foundation](checkpoint-evidence-2026-10-26.json) and [event](event-checkpoint-evidence-2026-10-26.json) snapshots remain distinct.

| Command/report                                    | Observed result and scope                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, typecheck/build | All exited 0 in the current runner                                                                                                                                                 |
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

## D. Documentation

Root [README](../../README.md), every package README, ten ADRs, architecture records, [Live protocol](../guides/live-protocol.md), [hardening](../security/hardening.md), partial [ASVS mapping](../security/asvs-traceability.md), preliminary [security review](../security/security-design-review.md), community policies and [changelog](../../CHANGELOG.md) exist. The production docs website and guides for undelivered systems remain required work.

## E. Artifacts

Version 0.1.0-alpha.0 tarballs are under artifacts/packages. The pack report and tracked registration summary contain package names, SHA-256 values and consumer commands. Reports/logs are under artifacts/reports; readable docs snapshots under artifacts/docs. No publication, SBOM, provenance attestation or approved release manifest is claimed.

## F. Known issues and unmet gates

Full Live behavior, forms/uploads, alternative engines, official Inertia React/Vue/Svelte integrations, hybrid islands, universal actions, realtime/distributed stores/cache/jobs, extensions, CLI and automatic default bootstrap remain unmet. Linux is unverified because the local Docker daemon is unavailable. Full Nest/platform/browser/fault matrices, project-wide coverage, mutation/fuzz/long-memory/load tests and independent review remain open.

Memory state/sample sessions are single-process without durable exactly-once business guarantees. Hosts own authentication, principal/tenant selection, logout revocation, body limits, production sessions, renderer lifecycle, TLS/proxy policy and business transactions.

## G. Owner release steps

After all gates pass: verify package/scope ownership, trademark/license review, official repository/maintainer/private security contacts and protected trusted-publishing controls; approve version/tag; review artifacts/security evidence; explicitly authorize publication. No remote push, namespace reservation or npm publication occurred.

## H. Maintenance

The unreleased version is 0.1.0-alpha.0. Public changes need tests, docs, a Changeset and migration review. Local commits 2bb6274 and 25b45d0 preserve earlier verified slices; registration hardening is saved separately by the coordinator. Finish mandatory implementation and adopt supported release/security windows before public distribution.
