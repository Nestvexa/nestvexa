# Feature matrix

Maps the [master specification](../NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md) to packages
and their real status on **2026-11-05** (`0.1.0-alpha.0`). The machine-readable source of
truth is the [feature ledger](implementation/feature-ledger.md) (`feature-ledger.json`);
when this page and the ledger disagree, the ledger wins and this page is stale.

Status words used below:

- **Shipped (alpha)** — implemented, covered by integration and (where relevant)
  three-browser tests, documented, packed. Still alpha: no stability promise.
- **Partial** — the core behavior works and is tested, but named clauses are missing.
- **Missing** — not implemented. Do not rely on it.

Nothing here is release-ready: an independent security review, load/fuzz/mutation
testing and a two-replica Redis browser run have not been executed
([status](implementation/STATUS.md)).

## By specification area

Ledger row counts as of 2026-11-05 (Done / InProgress / Pending). A heading row stays
InProgress until all of its children are Done, so counts understate working features.

| Spec § | Area                          | Ledger group(s) | Done / InProgress / Pending | Packages                                                                                                               | Status       |
| ------ | ----------------------------- | --------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| 4–5    | Public API, kernel, Nest glue | CORE            | 0 / 26 / 23                 | `@nestvexa/core`, `nestvexa`                                                                                           | Partial      |
| 6      | Template engines              | VIEW            | 13 / 13 / 0                 | `@nestvexa/views`, `@nestvexa/engine-hbs`, `@nestvexa/engine-ejs`, `@nestvexa/engine-pug`, `@nestvexa/engine-nunjucks` | Partial      |
| 7      | Live protocol and components  | PROT, LIVE      | 8 / 8 / 27                  | `@nestvexa/live`                                                                                                       | Partial      |
| 8      | Browser runtime, directives   | BROW, DIR       | 12 / 23 / 13                | `@nestvexa/client`, `@nestvexa/alpine`                                                                                 | Partial      |
| 9      | Forms and validation          | FORM            | 6 / 7 / 0                   | `@nestvexa/forms`                                                                                                      | Partial      |
| 10     | Uploads and downloads         | UP              | 6 / 5 / 0                   | `@nestvexa/uploads`                                                                                                    | Partial      |
| 11     | Inertia v3 and SPA adapters   | INERT, SPA      | 12 / 16 / 0                 | `@nestvexa/inertia`, `@nestvexa/vite`, `@nestvexa/react`, `@nestvexa/vue`, `@nestvexa/svelte`                          | Partial      |
| 12     | Hybrid islands                | ISLAND          | 3 / 10 / 1                  | `@nestvexa/islands`                                                                                                    | Partial      |
| 13     | Universal server actions      | ACT             | 8 / 8 / 0                   | `@nestvexa/actions`                                                                                                    | Partial      |
| 14     | Realtime                      | REAL            | 2 / 12 / 0                  | `@nestvexa/realtime`                                                                                                   | Partial      |
| 15     | Caches, stores, jobs, auth    | DATA            | 0 / 17 / 3                  | `@nestvexa/cache`, `@nestvexa/realtime` (jobs), `@nestvexa/i18n`                                                       | Partial      |
| 16     | Optional ecosystem            | EXT             | 12 / 15 / 5                 | `@nestvexa/ui`, `@nestvexa/ai`, `@nestvexa/flags`, `@nestvexa/offline`, `@nestvexa/observability`, `@nestvexa/mail`    | Partial      |
| 17     | Security gate                 | SEC             | 0 / 0 / 31                  | all                                                                                                                    | Not accepted |
| 19     | CLI and tooling               | DX              | 0 / 30 / 6                  | `@nestvexa/cli`                                                                                                        | Partial      |
| 21     | Test strategy                 | QA              | 0 / 2 / 90                  | repository                                                                                                             | Not accepted |
| 22     | Documentation                 | DOC             | 0 / 0 / 41                  | `docs/`, `apps/docs`                                                                                                   | See below    |

## Product modes

| Mode (spec 1.3)            | Works today                                                                                                           | Main gaps                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| MVC                        | HBS default, EJS/Pug/Nunjucks adapters, layouts, escaping, cache — **Shipped (alpha)**                                | Namespaced views, permission/URL/meta helpers, themes, view-rendered error pages (VIEW-006/018/021/026) |
| Live                       | Decorated components, actions, computed, locked/URL/session state, nesting, events, effects, directives — **Partial** | Shared/Redis Live state store (DATA-004/005); replays and identity locks are single-process             |
| Inertia (React/Vue/Svelte) | Server adapter for the v3 protocol, official clients, Vite manifest/dev/SSR — **Partial**                             | Precognition, browser verification of client-owned features, CLI scaffolding (INERT-002/013, SPA-006)   |
| Hybrid                     | Allowlisted islands in HBS/Live pages with an event bridge — **Partial**                                              | Island SSR, signed props, noscript, shared context, bundle budgets (ISLAND-004/007/009/011/012)         |
| API coexistence            | Host REST routes untouched; opt-in universal actions — **Partial**                                                    | GraphQL/microservices coexistence untested; action streaming/202 results and tracing (ACT-008/012)      |

## Feature details

| Feature                                                  | Package                                                | Status          | Evidence / notes                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NestvexaModule.forRoot` / `forRootAsync`                | `nestvexa`, `@nestvexa/core`                           | Shipped (alpha) | [umbrella Live tests](../tests/umbrella-live.test.ts)                                                                                                                         |
| Client asset hosting (`nestvexa/assets`)                 | `nestvexa`                                             | Shipped (alpha) | [assets tests](../tests/assets.test.ts); SRI/CDN missing (CORE-045)                                                                                                           |
| Live action routes through the Nest pipeline             | `@nestvexa/live`                                       | Shipped (alpha) | [live tests](../tests/live.test.ts), [security](../tests/live-security.test.ts)                                                                                               |
| Model sync, writable allowlist, validators               | `@nestvexa/live`, `@nestvexa/client`                   | Shipped (alpha) | [model tests](../tests/live-model.test.ts)                                                                                                                                    |
| Nested components and browser events                     | `@nestvexa/live`, `@nestvexa/client`                   | Shipped (alpha) | [nesting tests](../tests/live-nesting.test.ts)                                                                                                                                |
| Server-pushed `@OnEvent` domain events                   | `@nestvexa/live`, `@nestvexa/realtime`                 | Missing         | LIVE-012                                                                                                                                                                      |
| Shared / Redis Live state store                          | `@nestvexa/live`, `@nestvexa/realtime-redis`           | Shipped (alpha) | [store contract tests](../tests/live-store-contract.test.ts); single Redis primary only (DATA-004)                                                                            |
| Live action options (idempotent, concurrency), deadlines | `@nestvexa/live`                                       | Shipped (alpha) | [action option tests](../tests/live-action-options.test.ts); single-process replay cache                                                                                      |
| Live protocol schemas, capabilities, error catalog       | `@nestvexa/live`                                       | Shipped (alpha) | [protocol reference](reference/live-protocol.md), [contract tests](../tests/live-protocol-contract.test.ts)                                                                   |
| Typed state synthesizers and `@State({ default })`       | `@nestvexa/live`                                       | Shipped (alpha) | Date, BigInt, enum, nullable, Set, Map, `defineSynthesizer`                                                                                                                   |
| Layered config, env mapping, diagnostics                 | `@nestvexa/core`                                       | Shipped (alpha) | [configuration reference](reference/configuration.md), [tests](../tests/core-config.test.ts)                                                                                  |
| Directives `nv:*`                                        | `@nestvexa/client`                                     | Partial         | [directive reference](reference/directives.md); HTML stream fragments unsupported (DIR-016)                                                                                   |
| Alpine `$live` bridge                                    | `@nestvexa/alpine`                                     | Partial         | `call/get/set` only; `state/on/dispatch/entangle` missing (BROW-014)                                                                                                          |
| Forms: Zod / class-validator, no-JS fallback             | `@nestvexa/forms`                                      | Partial         | [forms guide](guides/forms.md); no `@ActionInput` binding (FORM-005)                                                                                                          |
| Uploads: chunked, quotas, ClamAV, S3 SigV4               | `@nestvexa/uploads`                                    | Partial         | [uploads tests](../tests/uploads-http.test.ts); no Inertia upload adapters (UP-008)                                                                                           |
| Inertia props: shared, deferred, merge, once             | `@nestvexa/inertia`                                    | Shipped (alpha) | [golden tests](../tests/inertia-golden.test.ts)                                                                                                                               |
| Inertia SSR (HTTP gateway, fallback/strict)              | `@nestvexa/inertia`, `@nestvexa/vite`                  | Shipped (alpha) | [Vite SSR tests](../tests/vite-ssr.test.ts)                                                                                                                                   |
| Inertia Precognition                                     | `@nestvexa/inertia`                                    | Missing         | INERT-007                                                                                                                                                                     |
| React / Vue / Svelte boot and SSR helpers                | `@nestvexa/react`, `@nestvexa/vue`, `@nestvexa/svelte` | Partial         | Typed action hooks missing (SPA-003)                                                                                                                                          |
| Islands registry, mount strategies, bridge               | `@nestvexa/islands`                                    | Partial         | [islands tests](../tests/islands.test.ts)                                                                                                                                     |
| Universal actions + typed client codegen                 | `@nestvexa/actions`                                    | Partial         | [actions HTTP tests](../tests/actions-http.test.ts); framework hooks missing (ACT-014)                                                                                        |
| SSE / polling / WebSocket invalidation                   | `@nestvexa/realtime`, `@nestvexa/client`               | Partial         | [realtime tests](../tests/realtime.test.ts), [transports](../tests/browser/realtime-transports.spec.ts); presence per replica only, no per-component transport (REAL-004/009) |
| Redis-protocol broker and shared Live store              | `@nestvexa/realtime`, `@nestvexa/realtime-redis`       | Implemented     | Two-replica browser acceptance against Redis 7 ([services evidence](implementation/services-evidence-2026-11-05.json)); no Redis Cluster (REAL-014, DATA-004)                 |
| Jobs with progress                                       | `@nestvexa/realtime`                                   | Partial         | `JobRunner` over a `JobQueue` interface with idempotency, leases and cancellation; BullMQ documented as a recipe only (DATA-010)                                              |
| Privacy-scoped cache, tags, single flight                | `@nestvexa/cache`                                      | Partial         | [cache tests](../tests/cache.test.ts); not wired into render pipeline (DATA-006)                                                                                              |
| i18n, ICU-style catalogs, RTL                            | `@nestvexa/i18n`                                       | Partial         | No client hydration of catalogs (DATA-020)                                                                                                                                    |
| Accessible UI primitives                                 | `@nestvexa/ui`                                         | Partial         | Several components missing; no SPA adapter (EXT-017/020)                                                                                                                      |
| AI streaming chat with tool approval                     | `@nestvexa/ai`                                         | Shipped (alpha) | [AI tests](../tests/ai-approval.test.ts)                                                                                                                                      |
| Feature flags                                            | `@nestvexa/flags`                                      | Shipped (alpha) | [flags tests](../tests/flags-nest.test.ts)                                                                                                                                    |
| Email and notification bridge                            | `@nestvexa/mail`                                       | Shipped (alpha) | [mail tests](../tests/mail.test.ts); no attachments (EXT-029)                                                                                                                 |
| Offline drafts and snapshots                             | `@nestvexa/offline`                                    | Partial         | Offline action queue deliberately absent (EXT-014)                                                                                                                            |
| Tracing spans, metrics, redacted logs                    | `@nestvexa/observability`                              | Partial         | Spans only for Live mount/action/render; devtools minimal (DX-033/035)                                                                                                        |
| CLI `init`, `doctor`, generators, `remove`               | `@nestvexa/cli`                                        | Partial         | [CLI reference](reference/cli.md); `make:form/action/island/test`, `add react/vue/svelte` missing (DX-004/008)                                                                |
| Plugin SDK with capability negotiation                   | all                                                    | Missing         | Spec 29.1; see [architecture overview](architecture/overview.md#extensibility)                                                                                                |

## Documentation (DOC rows)

| Requirement (spec 22)                                       | Status          | Where                                                                                                              |
| ----------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Documentation website built in CI                           | Shipped (alpha) | `pnpm docs:build` → `artifacts/docs` ([site README](../apps/docs/README.md))                                       |
| Getting started per mode, tutorials, deployment, migration  | Shipped (alpha) | [getting started](getting-started/README.md), [tutorials](tutorials/README.md), [deployment](deployment/README.md) |
| Generated API reference for every package                   | Shipped (alpha) | `artifacts/docs/api/` from published `.d.ts`                                                                       |
| Internal link, anchor and snippet-provenance checks         | Shipped (alpha) | `apps/docs/src/build.mjs`                                                                                          |
| Compiling every TypeScript snippet                          | Partial         | Only provenance-marked snippets are verified against compiled sources                                              |
| Screenshots / visual regression of docs pages               | Missing         | DOC-041                                                                                                            |
| External link checking                                      | Missing         | Offline CI; external URLs are not fetched                                                                          |
| Arabic/RTL quickstart                                       | Missing         | `examples/admin-i18n` shows RTL rendering, but there is no translated quickstart                                   |
| Recipes (email, charts, SaaS multi-tenancy, AI stream, ...) | Partial         | CRUD, realtime, uploads tutorials and guides exist; email/charts/multi-tenancy recipes missing                     |

## By package

| Package                                                            | Role                                                             | Status          | Notable gaps                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| [nestvexa](../packages/nestvexa/README.md)                         | Default distribution and `nestvexa` bin                          | Shipped (alpha) | CommonJS `require` works; see CORE rows                  |
| [@nestvexa/core](../packages/core/README.md)                       | Config, module, registries                                       | Partial         | Extension API/capability registry clauses (CORE-034/046) |
| [@nestvexa/views](../packages/views/README.md)                     | Engine contracts, `SafeHtml`                                     | Shipped (alpha) | Namespaces, asset manifest hook (VIEW-006/010)           |
| [@nestvexa/engine-hbs](../packages/engine-hbs/README.md)           | Handlebars adapter                                               | Shipped (alpha) | Debug line info (VIEW-008)                               |
| [@nestvexa/engine-ejs](../packages/engine-ejs/README.md)           | EJS adapter                                                      | Shipped (alpha) | No CommonJS `default` export condition                   |
| [@nestvexa/engine-pug](../packages/engine-pug/README.md)           | Pug adapter                                                      | Shipped (alpha) | No CommonJS `default` export condition                   |
| [@nestvexa/engine-nunjucks](../packages/engine-nunjucks/README.md) | Nunjucks adapter                                                 | Shipped (alpha) | No CommonJS `default` export condition                   |
| [@nestvexa/live](../packages/live/README.md)                       | Live server runtime                                              | Partial         | Shared store, action options, server events              |
| [@nestvexa/client](../packages/client/README.md)                   | Browser runtime                                                  | Partial         | Directive matrix clauses (DIR rows)                      |
| [@nestvexa/alpine](../packages/alpine/README.md)                   | Alpine bridge                                                    | Partial         | `$live` API subset (BROW-014)                            |
| [@nestvexa/forms](../packages/forms/README.md)                     | Validation adapters, hardening                                   | Partial         | FORM-003/005/009/012                                     |
| [@nestvexa/uploads](../packages/uploads/README.md)                 | Uploads, storage, downloads                                      | Partial         | UP-005/008/009                                           |
| [@nestvexa/inertia](../packages/inertia/README.md)                 | Inertia v3 server adapter                                        | Partial         | Precognition, client-feature browser tests               |
| [@nestvexa/vite](../packages/vite/README.md)                       | Vite manifest, dev, SSR                                          | Partial         | Live/HBS page asset example (INERT-016)                  |
| [@nestvexa/react](../packages/react/README.md)                     | React boot/SSR helpers                                           | Partial         | Typed hooks (SPA-003)                                    |
| [@nestvexa/vue](../packages/vue/README.md)                         | Vue boot/SSR helpers                                             | Partial         | Typed composables (SPA-003)                              |
| [@nestvexa/svelte](../packages/svelte/README.md)                   | Svelte 5 boot/SSR helpers                                        | Partial         | Typed utilities (SPA-003)                                |
| [@nestvexa/islands](../packages/islands/README.md)                 | Framework islands                                                | Partial         | ISLAND rows                                              |
| [@nestvexa/actions](../packages/actions/README.md)                 | Universal server actions                                         | Partial         | ACT-008/012/014/016                                      |
| [@nestvexa/realtime](../packages/realtime/README.md)               | Realtime invalidation, broker, presence, jobs                    | Partial         | REAL rows                                                |
| [@nestvexa/realtime-redis](../packages/realtime-redis/README.md)   | Redis Live state store and realtime broker for multiple replicas | Partial         | DATA-004/005, REAL-014; single primary only              |
| [@nestvexa/cache](../packages/cache/README.md)                     | Privacy-scoped cache                                             | Partial         | DATA-006/007                                             |
| [@nestvexa/observability](../packages/observability/README.md)     | Spans, metrics, logs, devtools                                   | Partial         | DX-033/035                                               |
| [@nestvexa/i18n](../packages/i18n/README.md)                       | Locales, catalogs, RTL                                           | Partial         | DATA-020                                                 |
| [@nestvexa/ui](../packages/ui/README.md)                           | Accessible primitives                                            | Partial         | EXT-017/020                                              |
| [@nestvexa/ai](../packages/ai/README.md)                           | Streaming AI chat                                                | Shipped (alpha) | Provider adapters are host-supplied                      |
| [@nestvexa/flags](../packages/flags/README.md)                     | Feature flags                                                    | Shipped (alpha) | —                                                        |
| [@nestvexa/mail](../packages/mail/README.md)                       | Email templates, transports, notifications                       | Shipped (alpha) | No attachments                                           |
| [@nestvexa/offline](../packages/offline/README.md)                 | Drafts, snapshots                                                | Partial         | EXT-014                                                  |
| [@nestvexa/cli](../packages/cli/README.md)                         | `nestvexa` CLI                                                   | Partial         | DX-004/008/011/024                                       |

The package-level status is a summary judgement over the ledger rows named; each
package README lists its own production caveats.
