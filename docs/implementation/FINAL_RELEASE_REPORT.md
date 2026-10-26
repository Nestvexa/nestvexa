# Release checkpoint report — 2026-10-26

Continuation checkpoint: the event-modifier implementation passed **235 aggregate tests**, **36 browser cases across three engines**, and seven-package external npm/pnpm strict-TypeScript MVC/Live consumers. Windows/Node22.23.4 additionally passed strict compilation and the aggregate suite. The custom emitted client measures **13,388 gzip bytes** excluding Alpine (per-module compression estimate, not actual server transfer). The original foundation results below remain a historical snapshot; the new event-checkpoint evidence and current reports describe later changes. The release gate still rejects the incomplete master requirements.

**A. Status: NOT YET READY — BLOCKERS.** This is an interim implementation report, not the Phase 17 handoff. No complete phase is accepted. The [925-unit ledger](feature-ledger.md) records 76 InProgress, 849 Pending and 0 Done.

## B. What exists

Seven package areas contain runtime source and public types: `@nestvexa/core`, `@nestvexa/views`, `@nestvexa/engine-hbs`, `nestvexa`, `@nestvexa/live`, `@nestvexa/client`, and `@nestvexa/alpine`. The [HBS starter](../../examples/starter-hbs/README.md) and [cookie-backed Live counter](../../examples/live-counter/README.md) run through real Nest servers. Live uses explicit generated routes and host-provided identity, authorization and renderer contracts. Alpine installs explicitly in an ignored local subtree. Automatic default-distribution HBS/Live/Alpine bootstrap remains open.

Observed foundation versions: Windows host Node 24.13.0, pnpm 10.26.1, Nest 12.2.0, TypeScript 6.0.3, Handlebars 4.7.10, Vitest 5.0.5, Playwright 1.64.1. The Live example adds `express-session` 1.19.0 and `@alpinejs/csp` 3.17.5; axe Playwright integration is 4.14.0. See [compatibility](../architecture/upstream-compatibility.md) for available versus tested versions.

## C. Evidence inspected

| Command/report                              | Scoped observed result                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`, `pnpm typecheck`, `pnpm lint` | Coordinator recorded successful foundation builds/type checks/lint. Final reruns must follow new edits. External consumer fixtures compile separately with packed declarations.                                                                                                                                                               |
| `pnpm test`                                 | Previous aggregate 127/127 passed. A 2026-10-26 report was inspected with 160/160 passing; focused suites later replaced the shared report. Final aggregate collection remains required.                                                                                                                                                      |
| `pnpm test:e2e`                             | The first expanded Chromium run found one axe touch-target failure; sample CSS now uses 44px minimum controls. The coordinator reports a later 20/21 cross-browser run and a corrected isolated WebKit rerun after restoring the document doctype and keyboard focusability. Final aggregate browser rerun pending. No axe rule was disabled. |
| `pnpm test:pack`                            | Seven tarballs passed archive checks and strict TypeScript plus actual Nest MVC/Live consumers under both npm and pnpm. The inspected report timestamp is `2026-10-26T11:07:39.375Z`; each install, compile, HTTP smoke and package-entry import exited zero. This follows the recorded missing-workspace-link failure.                       |
| `pnpm docs:build`                           | Coordinator recorded 29 linked documentation snapshots. This is a source snapshot generator, not the required polished documentation website.                                                                                                                                                                                                 |
| `pnpm audit --audit-level high`             | Earlier high Multer advisory was fixed locally with 2.5.0 override and a clean rerun reported. Downstream apps need patched resolution until upstream updates. Final audit must follow dependency edits.                                                                                                                                      |
| Docker/Linux                                | Docker client exists; daemon connection failed. Linux execution remains untested.                                                                                                                                                                                                                                                             |
| Ledger generate/check/self-test             | Valid requirement coverage with no Done claims. Release mode intentionally rejects unfinished requirements.                                                                                                                                                                                                                                   |

The documentation auditor subsequently ran `pnpm docs:build` successfully on 2026-10-26: 33 documentation snapshots were generated and internal file links validated. Ledger check and negative self-tests passed; `node scripts/ledger.mjs release` correctly rejected the 925 unfinished units.

Reports under `artifacts/reports` are mutable working artifacts, including `vitest.json`, `playwright.json`, and `pack.json`. Counts above identify inspected checkpoints, not fresh acceptance of later source. Branch coverage, mutation/fuzz targets, comparative benchmarks, long-memory tests, independent security review and the full compatibility matrix remain absent.

## D. Documentation

Root [README](../../README.md), package READMEs, ten ADRs, architecture records, [Live protocol](../guides/live-protocol.md), [hardening](../security/hardening.md), partial [ASVS mapping](../security/asvs-traceability.md), preliminary [security review](../security/security-design-review.md), community policies and [changelog](../../CHANGELOG.md) exist. Guides for undelivered systems and the production documentation site remain mandatory work.

## E. Artifacts

Local tarballs are written under `artifacts/packages`; documentation snapshots under `artifacts/docs`. Seven version `0.1.0-alpha.0` archives passed the expanded npm/pnpm check: `nestvexa`, core, views, engine-hbs, live, client and alpine. `artifacts/reports/pack.json` lists archive paths, contents, SHA-256 digests and each consumer command. Later source edits require repacking; this is not publication acceptance. No SBOM, provenance attestation or publishable release manifest is claimed.

## F. Known issues and unmet gates

P1 release gates include the final accessibility rerun, full directive/lifecycle/input behavior, automatic umbrella bootstrap, complete protocol/security corpus, distributed concurrency/idempotency, Linux/Node/browser matrix, coverage and benchmarks. Inertia and official React/Vue/Svelte adapters, hybrid islands, universal actions, uploads, realtime, stores/jobs, full forms, CLI and extensions remain unmet requirements. The ledger retains the whole requested scope.

Memory state/session examples are single-process and provide no durable exactly-once business guarantee. Hosts own authentication, tenant selection, logout revocation, body-parser limits, persistent production sessions, TLS/proxy policy and business transactions. Component revisions do not replace those responsibilities.

## G. Owner release steps

After all gates pass: verify `nestvexa` and `@nestvexa` scope ownership; complete trademark/license review; supply official repository, maintainer and private security-contact details; configure trusted publishing and protected release controls; approve the initial version/tag; review artifacts and security evidence; then explicitly authorize publication. No package publication, namespace reservation or remote push has occurred.

## H. Maintenance

The current version is unreleased `0.1.0-alpha.0`. Public changes need tests, accurate documentation, a Changeset and compatibility/migration review. Complete mandatory implementation before presenting the framework as delivered. Adopt supported-version/security windows and owner-reviewed release processes before public distribution.
