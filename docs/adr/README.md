# Architecture decision records

ADRs record significant, hard-to-reverse decisions. Each records the alternatives that
were rejected, trade-offs, failure modes, compatibility consequences and the tests that
prove it. Proposing a new one is described in [governance](../../GOVERNANCE.md#decision-process).

| ADR                                                       | Decision                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| [0001](0001-architecture.md)                              | Small kernel, `nestvexa` default distribution, MIT licence, ESM-only output |
| [0002](0002-live-protocol.md)                             | Versioned Live requests with opaque server-state references                 |
| [0003](0003-nest-execution-pipeline.md)                   | Preserve the host Nest pipeline on generated routes                         |
| [0004](0004-renderers-and-islands.md)                     | Explicit renderer ownership and document transitions                        |
| [0005](0005-state-and-concurrency.md)                     | Owner-bound state, revisions and uncertain action effects                   |
| [0006](0006-security-and-trust-boundaries.md)             | Trusted templates, untrusted view data                                      |
| [0007](0007-packaging-and-release.md)                     | Local artifacts before publication; CommonJS hosts via `require(esm)`       |
| [0008](0008-compatibility-and-upgrades.md)                | Evidence-based compatibility and explicit upgrade boundaries                |
| [0009](0009-realtime-backpressure.md)                     | Authorized invalidation events with bounded delivery                        |
| [0010](0010-observability-and-performance.md)             | Redacted diagnostics and reproducible performance evidence                  |
| [0011](0011-live-update-hooks.md)                         | Authorized request boot and immutable field update hooks                    |
| [0012](0012-confirmation-lifecycle.md)                    | Confirmation is an abortable browser presentation step                      |
| [0013](0013-initialization-lifecycle.md)                  | Bounded initialization per component registration                           |
| [0014](0014-computed-evaluation.md)                       | Instance-local computed evaluation                                          |
| [0015](0015-production-client-bundle.md)                  | Canonical production Live bundle                                            |
| [0016](0016-tooling-glob-security-override.md)            | Scoped development-tool glob matcher override                               |
| [0017](0017-sort-inputs-and-read-only-streams.md)         | Server-approved order inputs and read-only text streams                     |
| [0018](0018-inertia-server-adapter.md)                    | Inertia v3 server adapter                                                   |
| [0019](0019-universal-server-actions.md)                  | Universal server actions and generated typed clients                        |
| [0020](0020-client-budget-revision.md)                    | Live client size budget revision                                            |
| [0021](0021-nested-components-and-events.md)              | Server-mounted nested components and browser-routed events                  |
| [0022](0022-forms-and-validation.md)                      | Forms, schema adapters and progressive fallback                             |
| [0023](0023-uploads-and-storage.md)                       | Uploads, temporary tokens and storage adapters                              |
| [0024](0024-frontend-adapters-and-ssr.md)                 | Frontend adapters, Vite integration and SSR                                 |
| 0025                                                      | Not assigned (number skipped; no decision was recorded under it)            |
| [0026](0026-extensions-i18n-ui-ai.md)                     | Optional extensions: i18n, UI kit, AI, feature flags and offline            |
| [0027](0027-documentation-site.md)                        | Documentation site built from repository Markdown                           |
| [0028](0028-workspace-and-build-tooling.md)               | Workspace and build tooling without a task orchestrator                     |
| [0029](0029-peer-dependencies-and-singletons.md)          | Peer dependencies and runtime singletons                                    |
| [0030](0030-live-kernel-boundary.md)                      | Live depends on the view contracts, not on the core kernel                  |
| [0031](0031-live-protocol-evolution-and-action-replay.md) | Live protocol evolution, idempotent replay and action concurrency           |
| [0032](0032-distributed-state-and-redis.md)               | Pluggable Live state, Redis adapters and distributed realtime               |
| [0033](0033-ui-kit-framework-wrappers.md)                 | UI kit framework wrappers on one markup contract                            |
| [0034](0034-devtools-browser-extension-scope.md)          | In-app devtools panel; browser extension out of scope for v1                |
| [0035](0035-live-layout-isolation-and-transitions.md)     | No Live layout, isolation or transition options                             |

## Writing an ADR

1. Copy the structure of a recent ADR. Include a title line `# NNNN — Decision`, a
   status line with a date, then context, decision, rejected alternatives,
   consequences and failure modes, and links to tests or evidence.
2. Use the next free number. Do not reuse 0025.
3. Never edit an accepted decision silently. Add a dated **Amendment** section (see
   [0007](0007-packaging-and-release.md)) or write a new ADR that supersedes it.
4. Link the ADR from the guide or package README it affects. `pnpm docs:build`
   lists it in the site automatically.
