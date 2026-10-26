# NESTVEXA — AUTONOMOUS MASTER ENGINEERING & IMPLEMENTATION PROMPT

> **Copy this entire document into an advanced coding agent with repository/terminal/browser access.**
>
> **Project:** Nestvexa — a production-oriented, open-source, TypeScript-first full-stack application layer for NestJS.
>
> **Execution instruction:** Implement the actual source code, tests, examples, tooling, documentation, and publish-ready npm artifacts. This is not a request for a proposal, mockup, demonstration-only scaffold, or architecture essay.
>
> **Planning baseline:** October 2026. Independently verify versions, upstream contracts, and dependency compatibility at implementation time; never treat version numbers in this prompt as immutable facts.

---

## 0. YOUR ROLE, MISSION, AND NON-NEGOTIABLE OPERATING RULES

You are a coordinated **principal-engineer-level virtual team** comprising a software architect, NestJS core specialist, TypeScript library architect, secure-by-design engineer, template/compiler engineer, frontend runtime engineer, Inertia protocol engineer, React/Vue/Svelte specialists, DX/CLI engineer, testing engineer, SRE/performance engineer, accessibility engineer, documentation engineer, and open-source maintainer. Work as if shipping a foundational framework that unknown third-party teams will run in production.

### 0.1 The mission

Build **Nestvexa** from an empty or existing repository into a genuinely usable, extensible ecosystem that adds Laravel/Livewire-like server-driven UI to NestJS, supports traditional HBS-based MVC by default, integrates Alpine.js, supports other server-side template engines through adapters, offers Inertia-compatible React/Vue/Svelte pages, and enables hybrid islands, type-safe server actions, realtime, enterprise safety, excellent tooling, and publication-ready standalone packages.

The finished system MUST:

1. Preserve normal NestJS controllers, providers, modules, dependency injection, guards, pipes, interceptors, exception filters, sessions, and routing wherever possible; extend rather than replace NestJS.
2. Install with **Handlebars (HBS) by default** and a working Alpine-powered live client. No React/Vue/Svelte installation required for an HBS-only app.
3. Allow selection of EJS, Pug, Nunjucks, and custom template adapters where technically supported, with honest feature/capability declarations.
4. Make stateful server-rendered, reactive components easy with TypeScript decorators and HTML directives; implement real end-to-end browser interactions, not synthetic demos.
5. Support official Inertia.js clients and v3 wire semantics (subject to verified upstream compatibility) for React, Vue, and Svelte; implement the **NestJS server-side adapter**, not an incompatible reimplementation of the Inertia client.
6. Support many page modes within one NestJS backend; maintain explicit renderer boundaries, asset isolation, per-app roots, and full-page navigation when crossing incompatible roots.
7. Offer explicit, validated, authorized universal server actions for multiple frontend consumers; never expose arbitrary service methods or instantiate arbitrary classes from client-supplied names.
8. Provide secure rendering, signed/bound state, input and action allowlists, CSRF protection, request validation, upload safeguards, concurrency control, tenant isolation, and production-friendly diagnostics.
9. Use first-class TypeScript, maintainable modules, strict testing, continuous integration, proper package exports, semver, release automation, contributor documentation, and real clean-install consumption tests.
10. Ship complete docs, examples, changelogs, migration instructions, package READMEs, quality evidence, and publish-ready npm tarballs **without publishing to npm or pushing remote changes unless the owner explicitly authorizes those external actions**.

### 0.2 Autonomous execution contract

- **Start implementing immediately.** Inspect the workspace, discover tooling, read upstream references, record design decisions, initialize the repo if necessary, and write source code.
- Do not stop after architecture, scaffolding, a proof-of-concept, or a successful compile. Continue across all phases, fixing issues and executing acceptance tests until the **Definition of Done** is satisfied or a genuine external blocker prevents a requirement.
- Do not ask for routine approvals, naming suggestions, tech-stack preferences, or phase-by-phase confirmation. Make professional, documented decisions and progress autonomously.
- Make a machine-readable progress tracker, persist phase state/checkpoints, and resume it after interruptions. At each checkpoint: implement → test → review → fix → document → commit locally when appropriate → continue.
- Use parallel specialists/subagents when available; coordinate shared public APIs and merge safely. Parallelize independent work; serialize architectural changes and integration-sensitive changes.
- **No fictitious completion.** Never call unrun tests passed, unsupported features complete, security fully guaranteed, zero defects proven, or all benchmarks achieved without measurement.
- **No placeholders masquerading as functionality:** reject TODO-only API exports, fake adapters, mocked integration tests advertised as production behavior, empty CLI handlers, silent no-ops, commented-out tests, skipped suites, blanket lint disables, nonfunctional UI demos, or green CI achieved by excluding important tests.
- For truly impossible capabilities or blocked platforms, implement a truthful capability boundary and document the precise limitation, test what is available, and mark the gap in a release blockers report. Do not claim full completion while mandatory requirements remain blocked.
- If external credentials, npm scope ownership, registry network access, deployment accounts, trademark clearance, security review, or package publication require human action, do everything possible locally, document the exact final human step, and do NOT fabricate authorization or sidestep the blocker.
- Keep repository clean and working continuously. Never overwrite user-owned code destructively; inspect first, create branches/backups as appropriate.
- Honor licensing, trademarks, intellectual property, and third-party license notices. Study Livewire and Inertia for behavior; do not copy proprietary assets or blindly transplant their code. Nestvexa must have its own original implementation of its live runtime and use upstream libraries where licensed and appropriate.
- In final output, be honest: 'publish-ready subject to scope ownership/credentials' is acceptable; 'perfect, fully secure forever' is not.

### 0.3 Hard acceptance rule

A feature is **DONE** only when it has all relevant: (a) production implementation, (b) public API & type contracts, (c) edge-case and negative tests, (d) real integration/browser test, (e) security considerations/tests, (f) docs, (g) example or fixture, (h) packaging verification, (i) backwards-compatibility considerations, and (j) no open P0/P1 bug. Track these per feature. Do not silently lower the bar.

---

## 1. VISION, POSITIONING, PRODUCT PROMISES, AND BOUNDARIES

**Brand:** Nestvexa. **Tagline:** *Build full-stack. Stay in Nest.*

**Positioning:** A NestJS-native full-stack rendering and reactivity ecosystem: ordinary SSR templates + Livewire-style server-driven UI + Inertia-powered modern frontend apps + deliberately isolated hybrid islands + shared secure TypeScript business actions.

### 1.1 The target applications

Support blogs, landing sites, authentication flows, CRUD applications, admin dashboards, analytic consoles, booking sites, catalogs, e-commerce application shells, multi-tenant SaaS, workflow dashboards, internal portals, streaming AI dashboards, accessible forms, localized RTL apps, and realtime enterprise tools **without providing an entire bespoke CMS/ORM/identity provider/payment processor**. Existing NestJS integrations remain available; Nestvexa integrates cleanly with them.

### 1.2 End-user developer experience

A new NestJS project:

```bash
npm install nestvexa
npx nestvexa init
npm run dev
```

This is the intended **future** command syntax; check that the names `nestvexa` and `@nestvexa/*` are legally/technically publishable. If not, do NOT rename the brand silently; use local workspace package names, record registry blockers, and report the needed owner action.

A fully configured default app must boot with HBS + layouts + Alpine + live actions without requiring a separate frontend SPA toolchain. Optional modules:

```bash
npx nestvexa add engine ejs
npx nestvexa add react
npx nestvexa add vue
npx nestvexa add svelte
npx nestvexa add realtime
npx nestvexa make:component Counter
npx nestvexa make:page Dashboard --renderer react
npx nestvexa doctor
```

CLI commands must support `--help`, dry-run where relevant, noninteractive `--yes`, idempotency, informative errors, Windows paths, and rollback of partially failed edits.

### 1.3 Five explicit product modes

1. **MVC:** Nest controller → template view → ordinary HTML, optional Alpine local interactions.
2. **Live:** Nest-registered component → server render → browser hydration → secure actions/state updates → targeted DOM updates.
3. **Inertia:** Nest controller → Inertia page object / initial HTML → official React/Vue/Svelte client → navigation/SSR/features.
4. **Hybrid:** Template page plus opt-in framework island(s), live component(s), or framework page plus an isolated live element where lifecycle ownership is safe.
5. **API coexistence:** REST, GraphQL, microservices, WebSockets, raw Nest endpoints coexist; Nestvexa does not hijack API routing or global middleware.

### 1.4 Explicit non-goals

- Do not reimplement NestJS DI, HTTP routing, Passport, ORM, queue framework, or official Inertia clients.
- Do not create a bespoke new frontend compiler language when standard HBS/EJS and HTML directives suffice.
- Do not advertise arbitrary same-root React/Vue/Svelte DOM ownership or seamless SPA navigation between heterogeneous client roots. Cross-renderer navigation defaults to safe full-document transition unless experimentally supported and proven.
- Do not make the low-level core depend on all renderer packages: a **convenience meta-package** imports default features; the **core kernel** stays small and acyclic.
- Do not persist confidential server-side providers/secrets in browser snapshots; signatures do not imply encryption.
- Do not include huge UI libraries, ORMs, cloud SDKs, all frontend frameworks, or Redis in the default runtime bundle.

### 1.5 Success demonstration

One sample NestJS server runs these independent routes concurrently:

| Route | Renderer | Verifiable experience |
| --- | --- | --- |
| `/` | HBS | layout, helpers, escaped interpolation, SEO-friendly HTML |
| `/counter` | Live/HBS | state/actions/validation, Alpine integration, no full reload |
| `/products` | Live/HBS | searchable, sortable, paginated table, forms, upload |
| `/admin/react` | Inertia React | navigation, form/validation, partial/deferred props, SSR |
| `/admin/vue` | Inertia Vue | same verified protocol and page flow |
| `/admin/svelte` | Inertia Svelte | same verified protocol and page flow |
| `/hybrid` | HBS + islands | safe React/Vue/Svelte island mounts + separate live widget |
| `/realtime` | Live + SSE or WebSocket | event-triggered authorized updates |
| `/api/health` | Native Nest | unaffected endpoint/guards/filters |

A real automated Playwright suite must exercise these flows in supported browsers.

---

## 2. UPSTREAM RESEARCH, VERSION MATRIX, AND ENGINEERING DECISIONS

Before code, read current primary documentation and upstream source/tests, then snapshot relevant contract versions in `docs/architecture/upstream-compatibility.md`:

- NestJS: https://docs.nestjs.com/ ; MVC https://docs.nestjs.com/techniques/mvc ; request/DI scopes; execution context; dynamic modules; HTTP adapters; validation; guards; interceptors; exceptions; CSRF; cookies; testing.
- Livewire 4: https://livewire.laravel.com/docs/4.x/quickstart ; components, actions, forms, islands, navigation, Alpine, directives, hydration, morphing, CSP, security, nesting, uploads, synthesizers, testing. Behavioral inspiration, **not** a drop-in wire protocol.
- Inertia.js v3: https://inertiajs.com/docs/v3/getting-started ; **canonical protocol** https://inertiajs.com/docs/v3/core-concepts/the-protocol ; React/Vue/Svelte client adapters, initial HTML page object, JSON visits, redirects, validation, SSR, code splitting, history encryption, shared/deferred/once props, progressive features. Inertia v3 appeared March 2026; check latest patch and any breaking changes.
- Alpine.js: https://alpinejs.dev/ ; integration, build, CSP considerations, initialization and mutation lifecycle.
- OWASP ASVS v5: https://asvs.owasp.org/ ; OWASP cheat sheets for XSS, CSRF, uploads, sessions, authorization, supply chain.
- Current Node.js release/support schedule, TypeScript, package manager, Vite, Express/Fastify, Handlebars, Playwright, Vitest, ESLint, and npm publishing documentation.

**Choose latest stable mutually compatible versions**, pin via lockfile/constraints, define supported Node LTS versions, TypeScript major/minor, NestJS majors, template engines, Alpine, Inertia, React/Vue/Svelte, and modern browsers. Avoid undocumented guesses and accidental peer incompatibilities. Document tested matrix and separate untested versions.

Produce these design records **and then implement them**:

- `docs/architecture/overview.md` — context/container/component diagrams and information flows.
- `docs/architecture/package-dependency-graph.md` — dependency DAG and optional peers.
- `docs/adr/0001-architecture.md` — separate core kernel and convenient distribution.
- `docs/adr/0002-live-protocol.md` — wire schema, versioning, snapshots, authorization.
- `docs/adr/0003-nest-execution-pipeline.md` — guards/pipes/interceptors/filters and request scope parity.
- `docs/adr/0004-renderers-and-islands.md` — DOM ownership/SSR/inertia separation.
- `docs/adr/0005-state-and-concurrency.md` — serialization, isolation, version conflicts.
- `docs/adr/0006-security-and-trust-boundaries.md`.
- `docs/adr/0007-packaging-and-release.md`.
- `docs/adr/0008-compatibility-and-upgrades.md`.
- `docs/adr/0009-realtime-backpressure.md`.
- `docs/adr/0010-observability-and-performance.md`.

ADR requirements: record alternatives rejected, tradeoffs, failure modes, cost, compatibility consequences, and links to implemented tests. Do not spend the project producing docs without code; research/ADR is short initial preparation before phased execution.

---

## 3. REPOSITORY AND MONOREPO STRUCTURE

Use a **pnpm workspace** (or equally mature documented alternative selected for demonstrated reasons), TypeScript project references where beneficial, task graph/cached builds (Turborepo/Nx only if justified), Changesets or equivalent versioning, and reproducible lockfile. Never force every example to install packages it does not use.

Proposed layout (adjust carefully with ADR):

```text
nestvexa/
├── .changeset/
├── .github/
│   ├── workflows/ci.yml
│   ├── workflows/security.yml
│   ├── workflows/release.yml
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── CODEOWNERS
├── .devcontainer/                # optional tested DX
├── apps/
│   ├── playground/
│   └── docs/                        # maintained documentation site
├── packages/
│   ├── core/                        # fundamental contracts + Nest integration
│   ├── nestvexa/                    # easy-install default/meta distribution
│   ├── views/                       # rendering registry, layouts, safe HTML
│   ├── engine-hbs/                  # default Handlebars engine
│   ├── engine-ejs/
│   ├── engine-pug/
│   ├── engine-nunjucks/
│   ├── live/                        # server component lifecycle + endpoints
│   ├── client/                      # browser runtime, Alpine integration
│   ├── alpine/                      # Alpine adapter/plugin; optional separate package
│   ├── morph/                       # focus-preserving DOM morphing
│   ├── forms/
│   ├── uploads/
│   ├── navigation/
│   ├── actions/                     # secure universal actions
│   ├── inertia/                     # official Inertia protocol server adapter
│   ├── react/
│   ├── vue/
│   ├── svelte/
│   ├── islands/
│   ├── realtime/
│   ├── realtime-redis/              # optional distributed broker
│   ├── queue/                       # optional jobs integration
│   ├── cache/                       # optional invalidation/cache primitives
│   ├── storage-s3/                 # optional storage adapter
│   ├── vite/
│   ├── cli/
│   ├── testing/
│   ├── devtools/
│   ├── observability/
│   ├── i18n/
│   ├── ui/                         # optional late-stage UI kit
│   └── schematics/                 # only if maintained; avoid redundant tools
├── examples/
│   ├── starter-hbs/
│   ├── starter-ejs/
│   ├── live-counter/
│   ├── live-crud/
│   ├── auth-forms/
│   ├── inertia-react/
│   ├── inertia-vue/
│   ├── inertia-svelte/
│   ├── hybrid-dashboard/
│   ├── realtime-dashboard/
│   ├── upload-to-s3/
│   ├── multi-tenant/
│   ├── express-host/
│   ├── fastify-host/
│   ├── offline-progressive/
│   └── integration-matrix/
├── tests/
│   ├── contracts/
│   ├── compatibility/
│   ├── security/
│   ├── browser/
│   ├── e2e/
│   ├── performance/
│   ├── fixtures/
│   └── pack-consumers/
├── docs/
│   ├── architecture/ adr/ guides/ packages/ reference/
│   ├── tutorials/ testing/ security/ deployment/ contributing/
│   └── feature-matrix.md
├── scripts/
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── GOVERNANCE.md
├── SUPPORT.md
├── CHANGELOG.md
├── ROADMAP.md
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── ...
```

**Package discipline:** Do not create dozens of empty packages just to mirror a diagram. Every publicly published package has a stable purpose, tests, docs, independent package entry points and meaningful source. Begin with a kernel and implemented vertical slices. Factor packages as the code matures without allowing circular imports or multiple competing implementations. Scope `@nestvexa/*` is proposed; confirm registry availability and account ownership. Provide a fallback local build process if the scope is unavailable, without inventing ownership.

### 3.1 Package and dependency rules

- `@nestvexa/core`: stable types, contracts, Nest DI/module integration, configuration validation, registries, platform abstractions. **Must not import live, React, Vue, Svelte, HBS, or Inertia.**
- `@nestvexa/views`: depends on core, exposes engine contracts and HTML safety abstractions.
- `@nestvexa/engine-hbs`: adapter for Handlebars; not inside core.
- `@nestvexa/live`: server runtime, decorated components, snapshot/state/action registry, Nest endpoints; depends on core/views; does not import browser DOM.
- `@nestvexa/client`: browser runtime, Alpine install and client orchestration; browser-only, tree-shakable; no imports from `@nestjs/*`.
- `@nestvexa/inertia`: server-side protocol integration and Nest integration; official frontend clients remain peer dependencies of React/Vue/Svelte adapters.
- `@nestvexa/actions`: typed, authorization-first server action registry usable by live and optional frontend adapters; do not create core/live/actions cycles.
- `@nestvexa/nestvexa` **or top-level `nestvexa`**: convenience package that imports and configures default core + views + HBS + live + client + Alpine. Decide the exact entry point and package naming once; use consistently across all docs, examples, and CLI.
- Optional adapters declare **optional peer dependencies**, compatibility ranges, and dynamic optional loading. No default frontend duplication.
- All packages publish ESM/CJS only as explicitly justified; choose a coherent modern output strategy, Node/browser conditions, `exports`, `.d.ts`, sourcemaps, `sideEffects`, bundler compatibility. Avoid dual-package identity hazards.
- Document singleton/peer dependency handling for NestJS and React/Vue/Svelte to prevent duplicated runtimes.
- No implicit circular package dependencies, deep private imports, wildcard untested exports, or mixed runtime-specific transitive imports.

### 3.2 Mandatory package metadata

Each publishable package: unique name, version, description, license, authors/maintainers placeholder explicitly documented, repository/bugs/homepage (real owner-provided URLs only), `exports`, `types`, `files`, `engines`, `peerDependencies`, `peerDependenciesMeta`, side effects declaration, build/test/lint scripts, published README, `npm pack --dry-run` verification, license inclusion, provenance/SBOM support where usable, and changelog strategy. Do not ship test fixtures, env files, private files, or local credentials in tarballs.

---

## 4. PUBLIC API DESIGN: CONSISTENT, NEST-NATIVE, TYPE-SAFE

Select a **canonical API** once, compile it in examples, lock it with API tests, and change it only through ADR + migration notes. Treat all snippets below as intended contracts; correct inconsistencies during implementation and update every example.

### 4.1 Setup and module integration

```ts
// app.module.ts — intended public API
import { Module } from '@nestjs/common';
import { NestvexaModule } from 'nestvexa';

@Module({
  imports: [
    NestvexaModule.forRoot({
      views: { engine: 'hbs', root: 'src/views' },
      live: { enabled: true, client: 'alpine' },
      security: { csrf: true, requireAuthorizedActions: true },
    }),
  ],
})
export class AppModule {}
```

Also implement `forRootAsync()` using NestJS `useFactory`, `inject`, and `ConfigService`, clear merge precedence (defaults/file/env/module overrides), startup validation, and support Express and Fastify with feature-specific capability checks.

### 4.2 MVC: prefer existing Nest decorators

```ts
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Render('products/index')
  async index() { return { products: await this.products.findAll() }; }
}
```

Do not replace working Nest MVC APIs; enhance layout/helpers/view registry via adapters and only add decorators when justified.

### 4.3 Live component sample

```ts
import { LiveComponent, State, Computed, Action } from '@nestvexa/live';

@LiveComponent({ name: 'counter', view: 'components/counter' })
export class CounterComponent {
  @State() count = 0;
  @Computed() get doubled(): number { return this.count * 2; }
  @Action() increment(): void { this.count += 1; }
  @Action() decrement(): void { this.count -= 1; }
}
```

```hbs
<section aria-label="Counter">
  <output>{{count}}</output>
  <p>Double: {{doubled}}</p>
  <button type="button" nv:click="decrement">-</button>
  <button type="button" nv:click="increment">+</button>
</section>
```

Use **`nv:`** as the canonical Nestvexa live HTML directive prefix unless a well-researched compatibility reason favors another. All docs/tests/client parser must agree. Directives are **data/configuration expressions**, not executable arbitrary JS.

### 4.4 Live with NestJS DI and guards

```ts
@LiveComponent({ name: 'users-table', view: 'components/users-table' })
export class UsersTable {
  constructor(private readonly users: UsersService) {}

  @State() query = '';
  @Action()
  @UseGuards(SessionAuthGuard, UsersAdminGuard)
  async remove(@ActionInput() input: RemoveUserDto): Promise<void> {
    await this.users.remove(input.id);
  }
}
```

Explicitly describe and implement what metadata decorators mean on non-controller method invocations. **A decorator alone is not guard execution**. Use Nest's public `ExecutionContext`, `ModuleRef`, metadata discovery, request-scoped context IDs and compatible integration points; if private Nest internals would be required, prefer first-class generated Nest route handlers or documented wrappers that guarantee middleware/guards/pipes/interceptors/filters parity and prove it with contract tests. Do not manually instantiate guards and call it parity. Preserve guard ordering, async behavior, global guards, scoped providers, exception handling, and request context.

### 4.5 Inertia page sample

```ts
@Controller('admin')
export class AdminController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @UseGuards(SessionAuthGuard)
  @InertiaPage('Admin/Users', { app: 'react' })
  async index() { return { users: await this.users.list() }; }
}
```

Choose `@InertiaPage` rather than ambiguous `@Page` if collisions are likely; provide a typed `InertiaService.render()` alternative and proper redirect helpers. Same Nest service can back separate React/Vue/Svelte page roots.

### 4.6 Universal actions sample

```ts
@Injectable()
@ActionGroup('cart')
export class CartActions {
  constructor(private readonly cart: CartService) {}

  @ServerAction({ id: 'add-item' })
  @UseGuards(SessionAuthGuard)
  async add(@ActionInput() input: AddCartItemDto) {
    return this.cart.add(input);
  }
}
```

Type generation should permit `actions.cart.add({ productId, quantity })` instead of fragile handwritten action name strings. Registration must be explicit, not scan every public service method. Support schema-based runtime validation, authorization, safe output DTOs and errors, abort/timeouts, and idempotency on opt-in actions.

---

## 5. CORE KERNEL AND NESTJS LIFECYCLE INTEGRATION

Implement `NestvexaModule`, validated typed config (sync/async), module discovery, application bootstrap, plugin registration, dependency injection tokens, request context, logger/tracing hooks, capability negotiation, renderer registry, safe shutdown, version negotiation and resource cleanup.

### 5.1 Hard technical requirements

1. Use public Nest APIs and semantics wherever possible. Test against supported Nest versions, Express and Fastify.
2. Avoid globals holding per-user state. Component instances must be request-isolated (or use explicit safe immutable singleton definitions + per-request state objects); never mutate singleton component fields across sessions.
3. Nest request-scoped dependencies must resolve using the correct request context ID; respect transient scopes and async services.
4. Do not bypass module visibility/exports or instantiate components outside intended DI registration.
5. Handle class decorators/method metadata from standard Nest TypeScript decorator configuration deliberately; document legacy decorators vs new TS decorators compatibility and set supported compiler flags.
6. Invocation pipeline: authentication → request/CSRF/origin checks → component/action lookup → state integrity/ownership checks → per-action authorization/guards → input transformation and validation/pipes → interceptors → action → lifecycle/render → filters/error mapping. Match Nest semantics where claimed.
7. Preserve global API prefixes, route versioning, configurable endpoint prefixes, proxies, TLS termination/trust proxies, cookies, CORS, base paths, host routing, and reverse-proxy deployment.
8. Register internal routes without accidental collisions; startup rejects conflicting names, action IDs or routes with actionable diagnostics.
9. Ensure global middleware, logging, filters, lifecycle hook ordering and cancellation behavior are tested.
10. Add an extension API with stable hooks and public types; use capability flags rather than guessing engine support.
11. Define error codes, public exception hierarchy, standard response envelopes (and request correlation IDs), configurable logging with sensitive-data redaction.
12. No hidden module side effects on import. Initialization, teardown, assets, and route hooks must be explicit and inspectable.

### 5.2 Runtime components

Construct and document these primary responsibilities:

- `NestvexaRegistry` — views, renderer adapters, components, safe actions, plugins.
- `NestvexaConfigService` — immutable normalized runtime config, schema validation.
- `LiveComponentRegistry` — unique stable IDs, metadata, DI tokens; no arbitrary client class resolution.
- `LiveActionExecutor` — Nest-compatible execution pipeline and well-defined error mapping.
- `RequestContextFactory` — tenant/session/principal/correlation/CSP nonce, public safe context.
- `RendererRegistry` — engine capabilities; no cross-engine assumptions.
- `AssetManager` — manifest/entry resolution/SRI when appropriate/hydration scripts/CSP.
- `FeatureCapabilityRegistry` — explicit supported/unsupported/degraded runtime features.
- `SecurityPolicyRegistry` — CSRF, snapshots, action authorization, upload quotas, origin checks.
- `DiagnosticsRegistry` — typed events/metrics/traces used by tests and devtools.

Write architecture tests that demonstrate core can be imported in a non-browser Node process without including React/Vue/Svelte/DOM bindings.

---

## 6. TEMPLATE ENGINE SYSTEM (HBS DEFAULT)

### 6.1 Engine abstraction

Create a fully typed `ViewEngineAdapter` with:

- register/initialize/dispose lifecycle;
- render template, partial, layout, reusable component and full document where supported;
- file resolution, extensions, aliases, namespaces and caching;
- custom helpers/filters, async data resolution via preload/compose layer;
- error reporting with template name/line/stack in development;
- capability flags (`layouts`, `partials`, `slots`, `asyncComposition`, `streaming`, `precompilation`, `safeHtml`, `viewComposers`);
- asset manifest integration;
- secure escaping policy, `SafeHtml` branded trusted output, user-controlled content defaults to escaped;
- path traversal prevention and no arbitrary filesystem template path supplied from the browser.

### 6.2 Handlebars

HBS must work immediately out of the box. Implement:

- standard escaped `{{value}}`; document that `{{{value}}}` bypasses escaping;
- layouts, partials, section/slots via composition pattern, local/global helpers;
- live component injection through a **trusted renderer integration**, not uncontrolled raw user HTML;
- `if`, `each`, formatting, date, currency, localization, user permissions via safe view model helpers;
- zero compile-time HBS dependency for optional frontend adapters;
- dev reload, precompiled production views where feasible;
- correct caching invalidation and error pages;
- tests for Unicode, HTML injection, prototype pollution, helper exceptions, missing partials and Windows paths.

### 6.3 Other engines

Provide genuine EJS, Pug and Nunjucks integrations, separately installable and independently tested. Support their actual security/escaping semantics. If a feature such as HTML streaming or layout slots needs a different implementation, do not pretend parity; declare capability and provide an alternative where sensible. Expose documented third-party plugin adapter contract and a working sample custom engine.

### 6.4 View composition and theming

Support request-aware view composers/global props (without leaking tenants), namespaced views, localization helpers, route link helpers, page metadata, layout nesting, themes and theme overrides, safe HTML fragments, and content security nonces. Make template layouts compatible with full HTML page and fragment render modes; always include only one correctly initialized client runtime per document.

---

## 7. LIVE SERVER COMPONENT ENGINE: WIRE CONTRACT & TRUST MODEL

Implement an original Nestvexa Live Protocol. Define canonical versioned request/response schemas in `packages/live/src/protocol`, publish JSON Schema/Zod (or suitable validated schemas) for inputs, maintain fixtures/golden files, fuzz parsers, and provide protocol evolution guidance.

### 7.1 Conceptual lifecycle

1. Initial Nest route renders template + registered component(s).
2. Each instance gets a stable opaque component identifier, initial serializable **public** state, owner/context binding and signed short-lived snapshot (or secure server-state token).
3. Browser runtime discovers component markers, attaches event listeners once, initializes Alpine once, and registers state/subtree ownership.
4. User interaction produces an allowlisted state delta and method/action ID; runtime debounces/bundles requests as specified.
5. Server validates HTTP method, content type, origin, CSRF, rate limit, payload size, component ID, signature/expiry/ownership/tenant/authorized state transition, and action input.
6. Resolve component safely via Nest DI for this request. Restore only allowlisted public state, never arbitrary object prototypes or injected dependencies. Verify lifecycle/authorization again.
7. Execute action within tested Nest-compatible pipeline; handle transaction/idempotency if configured.
8. Compute derived state, render server HTML or fragment, emit signed next snapshot/revision/redirect/events/errors and request correlation ID.
9. Browser discards stale responses, morphs only owned nodes, preserves focus/selection/scroll/Alpine state/uncontrolled DOM, and announces accessibility changes where appropriate.
10. Reconcile lifecycle, partial renders, nested components, errors, network retry, disconnection, user logout and version mismatch.

### 7.2 Concrete protocol design

Define payload envelopes and size limits. Example conceptual shape (rename fields as needed consistently):

```json
{
  "protocol": "nestvexa-live/1",
  "requestId": "opaque-request-id",
  "component": { "id": "opaque-id", "name": "counter", "revision": 3 },
  "snapshot": "signed-or-state-token",
  "updates": [{ "path": "count", "value": 2 }],
  "actions": [{ "id": "increment", "args": [] }],
  "client": { "capabilities": ["morph-v1"] }
}
```

This is NOT automatically secure; design exact canonicalization, JSON envelope validation, signatures/HMAC key rotation, anti-replay/version strategy, server-stored state option, user/session/tenant binding, expiration, optimistic or serialized concurrency model, request deduplication, response revision ordering, side-effect retry policies, and limits on nested payload depth. Prefer server-side stored state for sensitive/large data; browser snapshots are integrity-protected, **not secret**. Differentiate non-mutating refresh from mutating actions.

Document error statuses: unauthorized, forbidden, invalid/expired snapshot, stale revision/conflict, validation failure, unknown action, missing component, payload-too-large, rate limit, asset version mismatch, server error. Errors must not expose internals in production.

### 7.3 Lifecycle and public decorators

Implement and test a coherent set (not merely metadata):

- `@LiveComponent({ name, view, layout?, lazy?, isolated?, ... })`;
- `@State({ writable?, serializer?, default? })`;
- `@Locked()` or equivalent preventing client writes, with server persistence semantics clear;
- `@Computed({ cache?, ttl?, dependencies? })`; support sync getter and explicitly async computed method APIs; don't present `async get` as valid TypeScript;
- `@Action({ concurrency?, idempotent?, renderless? })`;
- `@Url({ key?, history?, except? })`;
- `@Session({ key?, ttl? })`;
- `@Reactive()` parent-to-child updates;
- `@Modelable()` controlled child model bindings;
- `@OnEvent()` for authorized cross-component/domain events;
- `@Lazy`, `@Defer`, `@Isolate` (or equivalent options);
- optional `@Renderless`, `@Transition`, `@Title`, `@Layout`, `@Validate` / schema integration where meaningful.

Hooks: mount/init, hydrate, boot, before/after update, before/after action, render, dehydrate, unmount/dispose, error. Define invocation order and restrictions, async support, cancellation, timeout, state transitions and nested hook ordering. Test that hooks execute exactly once when expected.

### 7.4 State semantics

- Arrays/objects/booleans/numbers/strings/enums/nullable fields/Date/BigInt where supported, typed custom synthesizers for domain types; explicit allowlist, round-trip guarantees, deterministic serialization.
- Prevent prototype pollution, getters with side effects, cyclic state crashes, unsupported `Map`/`Set` unless a trusted serializer exists, excessive depth/size, NaN/Infinity and arbitrary class constructors from client types.
- State updates must verify property writable/locked, dot path validity, normalization and input schema. Never trust UI-only disabled/read-only markers.
- Computed caching must be request/component-scoped by default and invalidated correctly; no stale cross-user cache.
- Parent/child scope, stable keys, reactive vs modelable props, inheritance rules and DOM change scope documented and tested.
- Version conflict: preserve user edits or reject coherently; never silently duplicate a payment/order action.
- Multi-tab consistency and user logout invalidation, stale-session behavior, tenant switching, expiry, signing key rotation.

### 7.5 Testing

Protocol contract, property-based serializer round trips, replay/tampering, network reorder, request bundling, nested component independence, concurrent users, tab reconnection, auth and tenant swapping, failures during render, and memory leak testing. Real browser tests required.

---

## 8. CLIENT RUNTIME, ALPINE, DOM MORPHING, AND DIRECTIVES

### 8.1 Browser architecture

Build a small modular browser runtime with:

- one-time initialization and idempotent mount/unmount, minimal footprint and code splitting;
- Alpine adapter that initializes Alpine exactly once, preserves existing host Alpine, detects incompatible/double versions, and exposes safe `$live` helpers without polluting globals unnecessarily;
- event delegation, binder, request scheduler, abort controller, debounce/throttle, request bundler, form client, navigation client, morph engine, island ownership registry, error/retry handling, version negotiation, diagnostics;
- robust SSR hydration, CSP-safe invocation (no `eval` or `new Function` on untrusted expressions), browser lifecycle and SPA navigation cleanup;
- keyboard/screen-reader handling, stable focus/selection, support for reduced motion, offline indicators, layout shifts.

### 8.2 DOM ownership

A single DOM node/subtree can have **one authoritative renderer**. Nestvexa live morphing owns live markup except explicit `nv:ignore`/island boundaries; React/Vue/Svelte own their island roots; Alpine may own local state attached to permitted nodes. Document and enforce teardown/re-init ordering, reparenting, teleport portals, ignored nodes, nested live components, CSP and external widget integrations. Never let two virtual DOM runtimes patch the same subtree simultaneously.

### 8.3 Directive implementation matrix (ALL required with real tests)

Implement these proposed directives or well-defined equivalents; preserve consistent names, documented modifiers, parser behavior, security constraints, and real examples:

| Directive | Behavior and must-test edge cases |
| --- | --- |
| `nv:click` | invoke action; click prevention, disabled, keyboard buttons, modifier semantics |
| `nv:submit` | validation, nested submit buttons, prevent duplicate mutation, disabled while pending |
| `nv:model` | two-way binding; `.live`, `.blur`, `.change`, `.debounce`, `.throttle`, `.number`, `.boolean`, `.lazy` where coherent |
| `nv:loading` | display/disable/class/attr targets; concurrent requests, screen readers |
| `nv:dirty` | distinguish form edits vs server state and restored snapshots |
| `nv:poll` | configurable interval, visibility throttling, backoff, cancellation, server quotas |
| `nv:init` | once, lazy timing, hydration reset handling |
| `nv:navigate` | navigate within compatible live pages; history, scroll, link interception, fallback |
| `nv:confirm` | accessible confirmation; promise-based approval; no security substitute |
| `nv:offline` | online/offline and request-level errors; no false guarantee of connectivity |
| `nv:transition` | enter/leave, reduced motion, cancelled transitions |
| `nv:show` | local/reactive visibility, ARIA and focus safety |
| `nv:stream` | target streaming chunks and cancellation; safe text/HTML semantics |
| `nv:sort` | pointer/keyboard reorder, validated stable item IDs, server authority |
| `nv:intersect` | intersection observer, repeat/once behavior, cleanup |
| `nv:ignore` | ignore subtree/self, DOM ownership separation |
| `nv:replace` | full replacement instead of morph, teardown/mount effects |
| `nv:text` | safe reactive text content, escape HTML |
| `nv:cloak` | remove only after successful init; avoid FOUC |
| `nv:current` | URL/current route active states, nested routes |
| `nv:ref` | local element reference with stable lifecycle |
| `nv:bind` | safe attribute/property binding; sanitize URL/style hazards |

Modifiers: `.prevent`, `.stop`, `.self`, `.once`, `.window` or `.document` only when safely scoped, key modifiers, `.debounce.300ms`, `.throttle.500ms`, `.live`, `.blur`, `.change`, `.number`, `.boolean`, `.lazy`, `.confirm` equivalents. Define precedence, parsing, unknown modifier errors, and event object sanitization. Do not support arbitrary JavaScript execution via action names or attribute strings.

### 8.4 Advanced browser features

Implement tested:

- DOM morphing with keyed nodes, stable inputs, caret and selection positions, textareas, selects, radio/checkbox, file inputs, contenteditable policy, preserved scroll, focus, nested component ownership, Alpine local state, teleports and out-of-order responses.
- Local Alpine plugin `$live.state`, `$live.call`, `$live.get`, `$live.set`, `$live.on`, `$live.dispatch`, `$live.entangle` only where intentional and documented; subscriptions automatically cleaned.
- Lazy hydration, deferred components, intersection-triggered load, visible loading placeholders, independent islands.
- Batch requests only when auth/session/tenant/security semantics and action ordering allow; limit batch sizes and provide bypass/isolation.
- Poll visibility pause and throttling; no hidden tab network storms.
- Prefetch with explicit safe GET-only mode, expiry and cache invalidation.
- Optimistic UI with predictable rollback/conflict errors; opt-in for mutating actions and stable idempotency.
- Async action progress and cancellation, streaming safe chunks, pending state transitions, retry with jitter only for safe/idempotent operations.
- Navigation with history, scroll restoration, progress, title/meta updates, dirty-form confirmation and full page fallback on unknown/heterogeneous routes.
- Browser developer instrumentation behind development feature gate, never expose secrets.

---

## 9. FORMS, VALIDATION, AND ACTION INPUT MODELS

Build composable `@nestvexa/forms` with:

1. Form state objects with fields/defaults, nested arrays and repeaters, multi-step wizard, reset, clear, touched/dirty/submitted/pending, validation state and errors.
2. Server-side validation through DTOs/class-validator/class-transformer and Zod (optional peers); no duplication of authority between client and server. Compiler/generator can derive safe client validation hints but server always validates again.
3. `@ActionInput()` extraction tied explicitly to typed action args/form state (avoid magic mismatch); support validation groups, partial validation, cross-field checks, async uniqueness checks, transform errors.
4. Clear rules for validation timing: submit, blur, change, debounce, explicit validate. Abort obsolete validation requests.
5. Error bags per form/field, accessible inline errors, global status, scroll/focus first invalid field, localized error messages.
6. Complex inputs: numbers/decimals/booleans/dates/selects/checkboxes/radios/multi-select/files; avoid losing user input on morph.
7. Autofill, browser Back, draft persistence, duplicate submit prevention, CSRF, method spoofing only if needed, safe redirects and flash messages.
8. Multi-step forms and autosave with explicit consent/security, reset, expiration, conflict resolution, server reconciliation.
9. Progressive HTML fallback for basic forms when JavaScript is disabled, with explicit route handlers, real CSRF tokens and redirects (not pretend live XHR works offline/no JS).
10. Portable form primitives accessible from HBS/live and framework adapters as feasible.

Test malicious or malformed forms, nested malicious keys, type confusion, oversized strings, dependent fields, async races, concurrent submit, form restore/back-forward, and browser accessibility.

---

## 10. FILE UPLOADS, DOWNLOADS, AND STREAMING

`@nestvexa/uploads`: opt-in storage-agnostic upload subsystem. Feature set:

- single/multiple files; progress; cancel/retry; chunked/resumable and direct-to-storage uploads;
- local temp storage with quotas and TTL cleanup; S3-compatible object storage adapter and signed upload URLs; no cloud credentials in browser;
- file extension/MIME/magic-byte validation, size/count/user/tenant quotas, random object names, path canonicalization, deny executable payloads, configurable malware scanning hooks;
- final ownership token bound to session/user/tenant/action; validate again on finalize; process outside webroot; safe download filename/content disposition/content type;
- lifecycle cleanup on failed uploads, interrupted clients, abandoned sessions and cancellation;
- integration with forms, React/Vue/Svelte Inertia uploads, tests using local storage and S3-compatible test service;
- secure streaming response helpers, backpressure, timeouts, range requests when supported, no open redirects or arbitrary URL fetching;
- cover 0-byte, huge, corrupted, spoofed MIME, zip bombs as threat model, path traversal, duplicate upload, slow streams and token replay.

No mandatory S3 SDK dependencies for default installs. Avoid claiming malware scanning unless wired to a real configurable scanner.

---
## 11. INERTIA.JS V3 PROTOCOL AND REACT/VUE/SVELTE INTEGRATION

Implement `@nestvexa/inertia` as a **complete verified NestJS server adapter** for official Inertia.js clients. Read upstream v3 protocol docs and tests at coding time. Do **not** invent a parallel pseudo-Inertia protocol or merely send a JSON props object and claim compatibility.

### 11.1 Required protocol behavior

- Initial full-document HTML response with correct page object embedded as safely serialized script JSON in the exact form required by the supported Inertia version; prevent embedded `</script>` injection, including forward slash escaping as specified in v3 docs; no HTML-entity encoding of JSON inside script text.
- `X-Inertia: true` request handling, correct JSON page object, `Vary: X-Inertia`, content types/status codes and URL/version/component/props metadata.
- Asset/version mismatch handling (`409` and appropriate `X-Inertia-Location`/version headers), redirects and fragment handling (`X-Inertia-Redirect` when prescribed); location safety and open redirect protections.
- Relevant request headers: `X-Inertia-Version`, `X-Inertia-Partial-Component`, `X-Inertia-Partial-Data`, `X-Inertia-Partial-Except`, `X-Inertia-Reset`, `X-Inertia-Error-Bag`, prefetch indicators, once-prop exclusions, infinite-scroll merge intent, CSRF cookies/headers, optional precognition validation if official client supports it.
- Full page object semantics for regular/always/optional/deferred/merged/deep-merged/prepended/once/shared props, `deferredProps`, `mergeProps`, `deepMergeProps`, `prependProps`, `matchPropsOn`, `scrollProps`, `onceProps`, `sharedProps`, `flash`, `encryptHistory`, `clearHistory`, and other version-specific contract fields **as actually specified upstream**.
- Resolve props lazily; never evaluate all deferred/optional props simply to render the page. Partial reload requests may evaluate only the requested props under protocol rules. No stale tenant-user sharing.
- Shared props generated per request, reserved keys protected, errors default accurately shaped, flash data not persisted unexpectedly, secrets redacted.
- CSRF, session-based forms, validation error bags, redirect status rules (including appropriate POST/PUT/PATCH/DELETE -> GET transitions), progressive accessible error handling.
- History encryption semantics coordinated with official Inertia client; do not claim security guarantees beyond upstream behavior.
- Navigation, HTTP methods, view transitions, link component, manual/instant visits, partial reloads, deferred props, once props, infinite scroll, load-when-visible, polling, prefetching, remembering state and optimistic update **must be verified with the actual official clients**. Implement server support where server contracts require it and document client-owned features appropriately.
- Tests for malformed headers, incompatible asset versions, version refresh, 404/403/500 errors, unsafe redirect targets, page-not-found, undefined props, serialization of BigInt/Date, escaped HTML/script content, large/deferred data, user switching.

### 11.2 Framework adapters

Build separate and real:

- `@nestvexa/react`: `@inertiajs/react` official client setup, typed page resolver, Vite integration, hydration/SSR build, state/typed action integrations where appropriate.
- `@nestvexa/vue`: current official Vue adapter (`@inertiajs/vue3` or verified successor), proper plugin/root, SSR setup, Vite support.
- `@nestvexa/svelte`: official Svelte adapter, correct current Vite/SSR setup and mount/hydrate API. Do not assume React hydration works identically.

All adapters require independent runnable demos, install scripts, SSR and CSR tests, navigation/form tests, production asset builds, no leaked renderer dependencies in other apps, source maps, code splitting and HMR. Different frontend roots use different asset manifests/configured app IDs; avoid implicit mixed-framework same-root hydration.

### 11.3 SSR and asset pipeline

- Implement robust Vite integration for server-rendered HBS live pages, Inertia React/Vue/Svelte, islands, and production static assets. Vite development server and production build behavior must be explicit.
- Support separate SSR entry points (Node SSR worker/process when necessary), manifest lookup, preloads, dev HMR, fast reload, CSP nonce injection, cache busting and safe static serving.
- Avoid global side-effect registration and bundle duplicates. Browser-only imports never appear in Node SSR entry points. Verify hydration markers and server-client output agreement.
- SSR errors should fail gracefully according to explicit mode, not silently expose server internals or double-render on every failure.
- Test server start/build/deploy with Vite unavailable in production, and cold installs in CI.

### 11.4 Routing and multi-app rules

A NestJS application may have HBS routes, Live routes, React routes, Vue routes and Svelte routes. Preserve API routes. Design `@InertiaPage(..., { app: 'react' })` or equivalent renderer selector and path-based app roots. Same-framework Inertia navigation works without full reload where contract allows. Cross-framework/root navigation performs a normal full-page load unless a separately tested bridge is available; do not promise impossible universal SPA navigation.

---

## 12. HYBRID FRAMEWORK ISLANDS & SHARED COMPONENT BOUNDARIES

Build `@nestvexa/islands` with a stable islands descriptor protocol and explicit DOM ownership, allowing HBS page shells to mount client React, Vue and Svelte components and separate Live components. Add **Live-in-framework page** integration only when tested renderer ownership can be preserved and documented.

### 12.1 Features

- Island manifest, framework identifier, component ID, bundle path, client-safe props, mount strategy (`immediate`, `visible`, `idle`, `interaction`), optional SSR HTML and hydration state.
- Client islands loader with per-framework chunk lazy loading, mount/unmount, resource cleanup, error boundaries, per-island diagnostics, event bridge with namespaced events.
- Build-time registry of allowed component names; never import arbitrary client-requested filesystem modules.
- Strict prop serializing/escaping, size limits, signed/authorized server-provided props when needed; never leak secrets via SSR markup.
- Safe HTML helper syntax designed per template engine (e.g., trusted `{{{nvIsland "RevenueChart" app="react"}}}` is safe **only** because it returns opaque framework-created `SafeHtml`, not raw untrusted strings).
- Shared localized theme and design tokens, user-safe context, transport client and typed action interface; tenant/permission checks server-side.
- Controlled event/message bridge with explicit lifecycle, payload validation, no unbounded global emitter/memory leaks.
- Error boundary/fallback content, graceful noscript, accessibility, SSR hydration mismatch reporting.
- Stable performance budgets and deferred mount strategies.

### 12.2 Prove cross-framework coexistence

In the same page render: HBS layout + live notifications + React revenue chart + Vue activity feed + Svelte widget. Mutate independent components, navigate, update parent HBS live subtree, prove islands remain mounted and their state is preserved. Then remove and reinsert an island, verify cleanup. Add browser tests for duplicate initialization and unmount race. Prove frontend bundle separation with build bundle analyzer.

---

## 13. UNIVERSAL SECURE SERVER ACTIONS & FULL TYPE GENERATION

`@nestvexa/actions` is an opt-in, renderer-neutral action system built on NestJS business services, not an unrestricted RPC endpoint.

### 13.1 Server model

- Explicit action group and action registration with stable names, explicit versions and collisions detection.
- Runtime input/output schemas, DTO support, typed request context; independent validation at trust boundary.
- Guards/pipes/interceptors/filters compatibility, tenant/owner policies, CSRF where browser cookie auth is used, rate limiting, timeouts, request limits and idempotency.
- Server method calls preserve Nest DI and scopes; never deserialize trusted service objects from client.
- Action return types: JSON-safe outputs, validation errors, redirect, notifications, optional streaming handle/job ticket, accepted async job; avoid returning raw internal exceptions/entities.
- Actions cannot be exposed based solely on `@Injectable`; require explicit group/action registration with documented routes.
- Action naming is non-guessable only where secrecy is explicitly part of defense; **always** authorize, do not use obscure paths as a security control.
- Serial versus parallel action dispatch policy, atomicity/transaction boundaries and rollback behavior; no implicit DB transactions around arbitrary work.
- Include request identifiers, structured logs and tracing; redact sensitive inputs.

### 13.2 Typed clients

Create an incremental build-time generator using TypeScript AST/compiler API, schema metadata or a simple explicit registry—not brittle source regex. Generate `d.ts`/typed client functions for live HBS helpers, React hooks, Vue composables and Svelte utilities. Preserve input/output generics, validation error unions, cancellable requests, optional optimistic update types; handle nullable/optional nested types and schema evolution. Generated clients must work from packed packages outside monorepo paths. Support code generation diagnostics and stable deterministic output.

### 13.3 Security and tests

Negative tests for unknown action IDs, missing guard, forged user claims, malformed DTO, tampered/expired token, swapped tenants, mass assignment, replays, duplicate order/payment actions and unauthorized subscriptions. Verify throttling/CSRF/origin/permissions on action endpoints. Compare generated TypeScript types against compile-time fixtures and real calls.

---

## 14. REALTIME ENGINE: SSE, WEBSOCKET, POLLING, DISTRIBUTED EVENTS

`@nestvexa/realtime` implements broker/transport-neutral authorized component updates; optional `@nestvexa/realtime-redis` supplies cross-instance pub/sub. Integrate documented Nest gateways/SSE, not a private competing websocket stack.

### 14.1 Capability set

- Configurable `polling | sse | websocket | auto` per app/component; capability negotiation and fallback.
- Authenticated subscription handshake, explicit tenant/user/channel authorization, revalidation on session expiry/revocation and after permission changes.
- Reconnect with exponential backoff + jitter, heartbeat, cursor/event IDs for replay when backend supports it, circuit breaker and connection caps.
- Server event → registered dependent component invalidation → selective refresh, not execute arbitrary client-named methods.
- Redis pub/sub adapter for horizontal scale, with documented delivery guarantees and no fictitious exactly-once claim; backplane topology examples.
- Presence tracking, live notifications, job progress, dashboards, user-specific broadcasts, group/team channels and fine-grained authorization.
- Optional smart render graph with explicit `@DependsOn`/query tags and conservative invalidation; do not implement speculative magic dependency detection unless correct.
- Backpressure/queue length limits, payload quotas, rate limits, cost controls, graceful disconnect and graceful shutdown.
- One default simple mode that works without Redis; distributed mode is optional.

### 14.2 Cross-process tests

Two server replicas + Redis (or test service) + multiple browsers/users/tenants. Confirm an event emitted on server A updates subscribed component through server B, unauthorized users never receive content, browser reconnects and deduplicates, no subscription leaks, and slow clients are handled safely. Test SSE as well as WebSocket in both supported Nest HTTP adapters where feasible. If a transport is unsupported by an adapter, detect at startup and document it—do not fake parity.

---

## 15. CACHING, STORES, ASYNC JOBS, AND OTHER NEST INTEGRATIONS

### 15.1 State stores and cache

- Memory store for development/single process with eviction and explicit caveats.
- Redis-backed state with tenant/user namespaced keys, TTL, safe serialization, encryption only if required for sensitive values, compare-and-set/version enforcement.
- Pluggable custom state store interface with lock/concurrency semantics.
- Render/data caching only when safe; cache key includes relevant renderer, locale, tenant, permission scope, asset version, component revision. Default no cache for private per-user HTML unless safely configured.
- Cache tags and invalidation, stale-while-revalidate only for safe nonpersonal responses, performance telemetry, stampede protection.
- No cache API that encourages sharing private signed snapshots across users.

### 15.2 Jobs and queues

- Optional Nest BullMQ/queue integration or adapter abstraction; working demo that generates a report and shows progress, success/failure/retry/cancel UI.
- Job ownership authorization, status expiration, idempotency, queue worker lifecycle, reconnect and results fetching, observability.
- Avoid bundling BullMQ/Redis into default distribution; optional adapter with tests.

### 15.3 Database and authentication interoperability

- Offer examples that use Prisma, TypeORM and Drizzle, without shipping ORM in core.
- Integrate Nest Passport/session/JWT authentication as documented, but do not write an insecure homegrown authentication framework.
- Optional auth starter with vetted provider patterns, credentials handling, secure cookies, CSRF, password resets/verification, login/logout, authorization policies and tests; explicitly separate illustrative starter from production identity configuration.
- Consistent logged-in user context through MVC, Live, Inertia, actions, islands, and realtime; all policies recheck server-side.
- Multi-tenancy: tenant selection and authoritative resolution server-side, no client-controlled tenant ID, isolation testing across all transports/cache stores.

### 15.4 Internationalization and RTL

Optional i18n helper/module: locale negotiation, namespaced resource catalogs, server/client hydration of safe locale, pluralization, dates/numbers/currency, fallback, timezone policy, RTL layout toggles, translation extraction hooks and testing. Support Arabic RTL examples; avoid mixing text direction with application authorization or cache keys.

---

## 16. ADVANCED FEATURES AND OPTIONAL ECOSYSTEM

Implement the following as real optional packages/extensions only after core stability and test infrastructure; include each in tracker, docs, samples, and acceptance gates. Where product semantics do not fit the kernel, design an explicit extension rather than pollute default package.

### 16.1 Performance and smart rendering

- Intelligent component invalidation via declared dependency tags, idempotent render scheduling, request deduplication.
- Lazy/visible/idle hydration, deferred props and components, incremental/nonblocking stream delivery where engine/transport supports it.
- Reactive islands selective refresh, read-only render fragment caching, early hints/preload only if deployable.
- Optimistic UI with typed mutation contracts, state rollback/conflict, cancellation and reorder-safe result handling.
- Server-side computed memoization with explicitly bounded, correct invalidation.
- Render budget policy/warnings for slow component render, large state payload, excessive island bundles, render loop, N+1 queries.
- Graceful degradation to full-page render or polling when client transport absent, where valid.

### 16.2 Progressive and offline

- HTML form/navigation progressive enhancement for fundamental workflows; `noscript` content.
- Offline detection plus local draft storage (opt-in, avoid PII by default), local read-only cache, safe reconnect, conflict UI.
- Optional constrained offline action queue for allowlisted idempotent operations only, with explicit security and data expiry; do not blindly replay purchases/payments/deletes on network restoration.
- Service worker plugin only if optional, CSP-compatible and documented; storage privacy and logout clearing policy.

### 16.3 Optional UI kit

- Theme-neutral accessible components: data table (sorting/search/filter/pagination/selection), modal/dialog, toast, tabs, dropdown, popover, form fields, select/combobox, datepicker, file uploader, step wizard, pagination, breadcrumbs, drawer, live notification badge, chart wrapper.
- Prefer reusable state/actions and adapters over duplicating four unrelated UI kits. Components must be keyboard accessible and documented with ARIA patterns, dark/RTL support.
- Keep UI kit opt-in; do not require Tailwind, Material UI, shadcn or third-party styling globally. Provide unstyled headless API and optional theme.
- At least one runnable example each in HBS/live and a SPA adapter for shared components where realistic.

### 16.4 AI optional adapter

- Streaming AI responses (text chunks and structured message envelopes) with model-provider-neutral adapter interface; demonstration may use a local deterministic fake provider for tests **but must be labeled a test provider**.
- Tool-call status, human approval steps, cancellation, timeout, audit events and safe server actions.
- Do not ship an actual AI provider key or pretend a fake model response is genuine LLM integration; optional adapter documents how to connect a real provider.
- Security: prompt content sanitized appropriately for rendering, tool actions must respect auth, never expose provider secrets.

### 16.5 Admin/business productivity scaffolds

- CRUD generation (controllers/services/DTOs/templates/live table/forms/tests) with selectable ORM interface and no unverified schema migration.
- Auth starter, administrative dashboard starter, reporting/job starter, multi-tenant starter, realtime starter and common search/pagination/filter primitives.
- Email/notification template bridges using Nest integrations; avoid duplicating mail providers.
- Optional route-to-type generator, typed URLs, permission-aware view helpers and frontend links.
- Optional feature flag adapters with server-enforced capabilities and rendering cache isolation.
- Version-safe portable component packages and plugin registry specification; dynamic plugin manifests require explicit trusted installation, never remote untrusted code execution.

---

## 17. SECURITY, PRIVACY, AND THREAT MODEL — BLOCKING GATE

Treat Nestvexa as a network-facing framework. Map relevant requirements to **OWASP ASVS 5.0** and current cheatsheets, document all trust boundaries, include threat model diagrams, and make security testing blocking for release.

### 17.1 Threat boundaries and attacker capabilities

Assume untrusted browser, forged HTTP/WebSocket/SSE messages, malicious state snapshots, corrupted serializations, injection strings, hostile uploaded files, cross-origin sites, compromised browser extensions, multiple tenants, stolen old session tokens, compromised cache records, concurrent tabs, malicious/buggy third-party extensions, slowloris clients, and high volume. Signed snapshots can be stolen/replayed; mitigate with appropriate binding/expiry/revisions/revocation, not signatures alone.

### 17.2 Mandatory controls

**Identity/authentication:** Existing Nest auth guard integration, signed/encrypted secure cookies where host config demands, revocation, session fixation protection in starter examples, per-request principal resolution, tenant context, logout invalidation. Do not automatically trust a `userId` passed in action JSON.

**Authorization:** recheck permission for every action, read, upload, lazy render, socket subscribe, deferred prop, job progress and file download; support resource-level ownership and tenant isolation. `@Locked` prevents mutation but is **not** authorization.

**CSRF and origin:** CSRF tokens for cookie-authenticated state-changing live/actions/forms; SameSite/secure/httpOnly cookie policies where relevant; origin/referer checks as defense-in-depth; explicit CORS restrictions. Support host-native Nest CSRF approach when compatible; fail securely if required middleware is absent.

**State integrity and confidentiality:** HMAC authenticated snapshots with canonical payload and key rotation, user/session/tenant/component/version/expiry binding or server-stored opaque tokens; never expose services/secrets/private fields; encryption when confidentiality is required rather than signing only; constant-time comparisons where applicable; reject unknown/expired/altered payloads.

**Actions:** allowlist only, strict typed arg validation, prototype pollution defenses (`__proto__`, `constructor`, `prototype`), max payload depth/size, HTTP method and content type restrictions, no arbitrary method names, safe serialization and output DTO allowlists.

**Injection/XSS/CSP:** context-aware HTML escaping, template helper `SafeHtml` branding, script JSON escaping, URL scheme validation, CSS URL policy, prohibit arbitrary HTML unless explicitly trusted, sanitization only via maintained vetted libraries and when appropriate, CSP mode compatibility with Alpine expressions, nonces, no dynamic evaluation of untrusted directives.

**Headers/TLS:** secure headers defaults guidance, CSP headers, HSTS behind HTTPS, proxy trust configuration, clickjacking protection, MIME sniffing prevention and correct caching headers for private pages.

**Uploads:** file metadata/bytes validation, path traversal prevention, quotas, temporary token ownership, malware scanning extension hook, safe storage ACL, stale cleanup, decompression concerns, download header safety.

**Transport:** request limits, timeouts, backpressure, authenticated SSE/WebSocket subscriptions, CSRF or equivalent cross-site WebSocket defenses, rate limits, private broadcast channels, subscription revocation.

**Replay/races:** monotonic component revision, stale response discard, replay defenses based on effect sensitivity, idempotency keys for irreversible actions, confirmation not treated as auth, retry policy verified.

**Supply chain:** lockfile, dependency updates, GitHub dependency scanning/audit, npm package provenance where available, published integrity, license audits, secrets scanning, automated release protections, sandbox sample app secrets.

**Logging/privacy:** structured logs with redaction, PII-safe devtools, no raw passwords/cookies/tokens/signed state in logs/errors/traces, opt-in telemetry, documented retention and collection.

### 17.3 Security test corpus

Build at least one attack test per category and variant:

- forged/tampered/expired snapshot; mismatched user/tenant/session; stolen snapshot from another browser;
- unauthorized action despite hidden UI; locked property modification; mass assignment and proto pollution;
- DOM/XSS injection via HBS, Live update, props, Alpine, React/Vue/Svelte page JSON, script closing, URL/style attributes and streaming chunks;
- CSRF attack and origin bypass, websocket cross-site attempt;
- malformed `X-Inertia` headers and redirect injection;
- upload path traversal/mismatched mime/excess-size/unauthorized finalization;
- rate/size/batch limits, oversized/recursive JSON and zip bomb simulation;
- stale response, double submit, concurrent payment/order action, reconnect replay;
- isolation between two tenants sharing Redis/cache/job channels;
- SSRF in any URL-fetching integrations; unsafe dynamic imports; directory traversal in view paths;
- cache poisoning and request coalescing cross-user leaks.

Add `docs/security/threat-model.md`, `docs/security/security-design-review.md`, `docs/security/asvs-traceability.md`, `docs/security/hardening.md`, `SECURITY.md` vulnerability disclosure procedure and supported release policy. No 'military grade'/ 'unhackable' claims.

---

## 18. PERFORMANCE, SCALABILITY, AND RELIABILITY

### 18.1 Measurable performance goals

Establish baseline against equivalent plain NestJS + HBS and appropriate official Inertia setup, measure on pinned machine/Node version/browser. No invented numbers. Define configurable **initial budgets** (revise from measured evidence):

- minimal default browser runtime compressed JS budget explicitly recorded (target: be meaningfully smaller than an entire SPA framework; propose initial gzip cap e.g. 35 KB for Nestvexa custom live runtime excluding Alpine, adjust with ADR and measurements);
- small HBS first render and no-op action overhead measured; do not promise hard universal milliseconds independent of host;
- bounded live snapshot payload, max component nesting and batch size;
- bounded memory per component/session and no leaks after thousands of mounts;
- predictable cold build, incremental build, reload times;
- minimal additional network requests, progressive enhancement and cache usage;
- no O(N^2) morph algorithm in common path; profiling against large forms/tables;
- production source maps policy, bundled output analysis.

### 18.2 Testing and optimization method

Use Vitest benchmark or benchmark.js (select evidence-based), k6/Artillery/autocannon for API/action load, Playwright tracing and performance panel for browser, heap snapshots and allocation profiling. Measure warm/cold initial render, action latency p50/p95/p99, throughput, concurrency, memory, serialized bytes, DOM patch time, SSR throughput, builder output and render-induced DB requests. Simulate 10/100/1000 active concurrent components where hardware allows; record setup so runs are reproducible. Compare two backend replicas + Redis, test disconnect/reconnect and graceful shutdown. Optimize based on profiled bottlenecks, not premature cleverness.

### 18.3 Robustness

- Abort/timeouts, retries only for safe operations, connection pool considerations, state expiry and periodic cleanup.
- Deterministic order for conflicting actions, retry budgets, overloaded server/429 UX, rejection of unbounded intervals/event listeners.
- Stateless load-balancing option and sticky-session requirements clearly documented per state store choice.
- Slow client/SSE backpressure, Realtime cluster semantics, circuit breakers for optional services.
- Large app modular load, tree-shaking for frontend, source map/debug performance.
- Readiness/liveness examples, graceful shutdown and cleanup.

---

## 19. OPEN-SOURCE DEVELOPER EXPERIENCE, CLI, TOOLING

### 19.1 CLI feature checklist

Implement a robust command line program with help, version, doctor, diagnostics, machine-readable `--json`, quiet/verbose modes, dry run and migration safety:

```text
nestvexa init
nestvexa doctor
nestvexa add engine hbs|ejs|pug|nunjucks
nestvexa add react|vue|svelte|realtime|redis|i18n
nestvexa remove <feature>
nestvexa make:component <name> [--view hbs] [--module ...]
nestvexa make:page <name> [--renderer hbs|react|vue|svelte]
nestvexa make:layout <name>
nestvexa make:form <name>
nestvexa make:action <name>
nestvexa make:policy <name>
nestvexa make:resource <name> [--crud] [--orm ...]
nestvexa make:island <name> --renderer react|vue|svelte
nestvexa make:test <name>
nestvexa build
nestvexa inspect:routes
nestvexa inspect:components
nestvexa inspect:actions
nestvexa check
nestvexa migrate
```

Each implemented command needs actual file output/config integration, safe conflict handling, tested code generation, support for Windows PowerShell/Node paths, meaningful errors and `--help`; no empty template files. `remove` must guard against deleting user custom code. `migrate` uses reversible, version-aware codemods and dry-run; no destructive blind search/replace.

### 19.2 Setup expectations

- Init detects existing Nest app/compiler/package manager without assuming a specific repo layout; avoids duplicate imports, respects existing tsconfig and global Nest config.
- HBS-only setup **works without manually creating HTML asset pipeline boilerplate**.
- Adding optional frontend adapter sets up independent Vite entry and example page and adds scripts without breaking other adapters.
- Doctor checks Node LTS, package peer versions, Nest adapter, template engine, CSRF config, asset manifest, client duplication and signing keys without outputting secrets.
- Generated code follows chosen lint formatter and strict TS; templates can be customized and versioned.

### 19.3 DevTools and observability

- Development panel shows registered components, public state (redacted), action timings, network batches, lifecycle hooks, SSR/HBS/SPA renderer types, prop resolution, DOM morph timing, CSRF/auth errors, request IDs, cache hit/miss, background job progress and re-render causes.
- Browser extension is optional but if listed as a deliverable, provide real build/install docs, stable communication schema, safety gate disabled in prod, and functional tests. If not publishable as extension without external store access, ship source + build and document store listing manual action.
- OpenTelemetry integration adapter with spans around request, hydrate, guard, action, render, morph on client, asset lookup, realtime and SSR; no vendor lock-in; propagate trace context safely.
- Logs structured and redacted; errors show clear dev messages with clickable source locations only when development enabled.

---

## 20. QUALITY ENGINEERING, MAINTAINABILITY, DESIGN PRINCIPLES

### 20.1 Principles enforced by review

- **SOLID**: high cohesion, injected contracts, replaceable renderers/transports; small focused units.
- **DRY without false abstraction**: factor real shared behavior; do not hide distinct adapter differences behind impossible fake parity.
- **KISS / YAGNI** internally despite broad features: build correct minimal mechanisms, then compose features; avoid speculative abstraction layers not tested by two consumers.
- **Clean architecture**: core domain/contracts independent of frameworks/browsers/cloud vendors; adapters wrap dependencies; define package boundaries.
- **Composition over inheritance**, explicit configuration over magic, safe defaults, deterministic behavior, immutable registries, type-safe event contracts, action discoverability and appropriate capability errors.
- **Open/closed** via renderer/storage/transports plugins; backward-compatible semver and public extension contracts.
- **Single authoritative source of truth** per state/action, no duplicate registry caches with divergent updates.
- Security and accessibility built in from day one, not patched on at release.

### 20.2 TypeScript rules

- `strict: true`, noImplicitAny, strictNullChecks, exactOptionalPropertyTypes, noUncheckedIndexedAccess where feasible, useUnknownInCatchVariables, noFallthroughCasesInSwitch, isolatedModules, declaration output.
- Ban unchecked `any`, `// @ts-ignore`, blanket `eslint-disable`, type assertions hiding unsafe values, and non-null assertions without proof. Narrow `unknown` at boundaries with schema validation; allowed exceptions require localized explanation and test.
- Clear public interfaces/generics and `Readonly` where possible; branded IDs for sensitive tokens; discriminated unions for state transitions and errors.
- No mutable shared state across requests; avoid leaky `AsyncLocalStorage` context propagation.
- File naming consistent; pure functions for protocol serializer/parser where possible; no unbounded module import side effects.
- Public APIs have JSDoc with examples, deprecation tags, thrown errors/capability notes, and readable names.
- Design for testability: dependency injection for time/UUID/random/transport/IO, fake clock fixtures, deterministic snapshots, no direct timers in core logic when injectable scheduling works.

### 20.3 Source formatting and review

- ESLint flat config with TS, Prettier, import cycle checks, consistent imports, public API extraction (API Extractor or equivalent), duplicate dependency analysis, package type tests.
- Max complexity or cognitive complexity checks for crucial parser/security paths; refactor large methods. No arbitrary 3000-line classes, clever metaprogramming, duplicated validators or silent catch-all exceptions.
- All platform-boundary code behind adapters; never mix DOM and Nest request logic.
- Commit messages use Conventional Commits, logical atomic changes and changelog generation. Maintain changelog changesets for public package changes.
- Architectural lint rules enforce package dependency DAG and browser/Node import separation.

### 20.4 Compatibility and public API evolution

- Document semver guarantees, experimental flags, feature deprecations with warning period, migration guides and versioned protocol support.
- Every public package tested from `npm pack`/`pnpm pack` in clean consumer, not just monorepo symlink development.
- Use explicit `exports` conditions and conditional typings and tests under Node ESM, browser Vite, and relevant TS `moduleResolution` modes.
- Public API snapshot/diff and protocol golden fixtures block unintended breaking changes.
- Maintain compatibility matrix by Node/Nest/browser/renderer/version/HTTP adapter; no untested promises.

---

## 21. COMPREHENSIVE AUTOMATED TEST STRATEGY

Use a **testing pyramid plus protocol/contracts/performance/security**. Tests must be deterministic, hermetic where possible and meaningful. Tests are release gates, not suggestions.

### 21.1 Unit tests

- Every schema validator, serializer/synthesizer, canonicalization/signature, component metadata collector, state guard, action resolver, method invocation, request scheduler, DOM diff helper, validation transform, URL state parser, engine view resolver, compiler/directive parser, config normalizer, asset resolver and typegen transform.
- Edge cases including `null`, `undefined`, cyclic object, Date/BigInt, prototype keys, deep nesting, arbitrary unicode/RTL, invalid bytes, duplicate IDs, stale states, corrupt manifests, missing views and handler exceptions.
- Property-based testing (`fast-check` or equivalent) for serialization, protocol parsing, path resolution and idempotent morph invariants.

### 21.2 Nest integration

- Boot actual Nest TestingModule with real generated server endpoints, DI scopes, global/class/method guards, pipes, interceptors, filters, middleware, sessions, exception semantics, request IDs.
- Verify method guards execute on Live/Universal Action invocations—not just class metadata exists.
- Verify transient/request scope behavior and absence of cross-user/tenant leakage.
- Same tests against Express and Fastify; clear capability flags if any combination unsupported.
- Existing REST routes/GraphQL/microservice config not unexpectedly overridden by Nestvexa; route versioning and global prefix.

### 21.3 Protocol and browser compatibility

- Golden request/response vectors for Live protocol and Inertia v3 protocol, invalid/missing header cases, correct initial SSR/script JSON/partial/version/redirect responses.
- Real official `@inertiajs/react`, Vue and Svelte client acceptance tests, each with actual installed supported versions.
- Browser tests for every live directive and modifier combination with representative accessible input variants.
- Full CRUD with validation, nested components, file upload, pagination, sorting, no-JS fallback, navigation, back/forward, events, concurrency, click spam, focus/selection preservation, Alpine local state retention, release of listeners on unmount.
- Hybrid page with all three island frameworks independently mounted and live updating; hydration, cleanup, error boundary and cross navigation fallback.
- SSR hydration tests with CSP nonces, safe script JSON, no hydration mismatch in reference fixtures.

### 21.4 Compatibility matrix

At minimum **CI matrices** on selected Node LTS versions, Linux and Windows; supported NestJS majors; Express and Fastify; current Chromium/Firefox/WebKit via Playwright for high-risk browser flows; HBS/EJS/Pug/Nunjucks; React/Vue/Svelte current supported ranges; TypeScript strict build. Optimize matrix using pairwise smoke + a smaller complete critical matrix, but run full release matrix before tagging. Publish actual matrix and green/red outcomes.

### 21.5 Security/chaos/fault injection

Dedicated attack corpus from Section 17; injection, cross-user, concurrency, interrupted upload, Redis downtime, lost SSE, websocket reconnect, external asset unavailable, invalid signing key/rotation, expired session mid-action, aborted SSR, unhandled promise, backend restart between state updates, slow network, 500 response and corrupt JSON. Validate graceful errors and no persistent resource leaks.

### 21.6 Accessibility

Automated axe-core checks in Playwright, semantic forms/labels/errors, aria-live/loading status, focus after modal/errors/navigation/morph, keyboard sortable lists and combos, high contrast and reduced motion support, browser zoom and RTL. Manual screen-reader test checklist documented where automation cannot prove behavior. Aim WCAG 2.2 AA for shipped UI kit/starter components, with explicit exceptions documented.

### 21.7 Performance tests

Maintain reproducible baselines, source fixtures, metrics artifacts for cold/warm requests, build and bundle size, benchmark history where possible, load tests, long-running memory leak profiles, render/morph stress, distributed realtime throughput. Fail CI on clear agreed regressions with stable environment rather than flaky arbitrary machine-specific wall-clock thresholds.

### 21.8 Mutation coverage and quality gates

- Coverage targets: **at least 90% branches on high-risk protocol/security/state/action modules** with targeted mutation/fuzz tests; meaningful project-wide coverage target such as 85% statements with documented exclusions; coverage is a signal, never a substitute for behavior verification.
- No skipped/`only` tests, no 100% mocked e2e, no ignoring red suites to pass.
- Set practical timeouts and retries for infrastructure flakes, do not mask reproducible issues.
- Every critical bug gets a regression test before or alongside its fix.
- Full clean-install test consumes packed tarballs in temporary external apps with no workspace aliases.

---

## 22. DOCUMENTATION REQUIREMENTS — REAL USERS MUST SUCCEED

A polished documentation website and markdown docs, with working copy-paste snippets compiled/tested. Do not just describe features; explain code and behavior, limitations, defaults, security and migration. English is the canonical initial language; architecture supports translations, and include an Arabic/RTL quickstart example if feasible.

### 22.1 Root `README.md` required structure

1. Name, concise value proposition, accurate project status and version/support badge generated from actual CI.
2. Architecture at a glance and supported rendering modes table.
3. 60-second install using umbrella package (`nestvexa`) with HBS/Alpine; actual commands must match package names.
4. Working hello-world MVC and Live counter with real tests.
5. Add EJS, React, Vue, Svelte; explain packages loaded/not loaded.
6. Live component API and lifecycle short primer; explain `nv:` directives.
7. Inertia usage with official client; current protocol limitations if any.
8. Hybrid island example and DOM ownership warning.
9. Universal server action pattern and security defaults.
10. Forms, uploads, realtime, SSR and production build quick pointers.
11. Security model, CSRF, locked state, snapshot confidentiality caveat, auth/tenant policies.
12. Packages table with package-level README links, dependency graph, compatibility versions and optional peers.
13. CLI commands and generated folder structure.
14. Runnable examples and commands.
15. Testing, benchmarks and production deployment guidance.
16. Contributing, coding standards, governance, license, vulnerability reporting, release policy, changelog, links to documentation site.
17. Explicit limitations/caveats; don't label unimplemented features as shipped.

### 22.2 EACH package README (mandatory)

For every real publishable package, create `packages/<name>/README.md` containing **purpose, installation (npm/pnpm/yarn where valid), peer requirements, minimal usage, public APIs, architecture role, dependency relationships, exported decorators/types, configuration defaults, examples, security/performance considerations, testing command, production caveats, compatibility, links to examples/changelog**. Explain how umbrella package includes it or how optional installation changes setup. Do not duplicate misleading snippets; verify examples in CI.

### 22.3 Detailed docs library

- Getting started, install and migration from vanilla NestJS, default HBS, alternative engine, Alpine, first Live component, first form, production deploy.
- MVC views: layouts/partials/helpers/composers/escape rules/themes/cache.
- Live deep guides: state, computed, locked, sessions, URL, actions, validation, nesting, events, lifecycle, hydration, morph, directives **individual reference pages**, loading/offline/navigation/transition/lazy/defer/islands/sort/poll/stream/uploads/pagination/redirect/downloads.
- Inertia: full protocol guide, React/Vue/Svelte quickstarts, SSR, forms, shared/deferred/once props, partial reloads, merging, history, redirects, CSRF, error pages, asset versioning, progress and SEO.
- Hybrid: DOM ownership, embedded islands, shared context, lifecycle, performance and fallback.
- Universal actions: typed codegen, client hooks, policies, testing, errors, idempotency and streaming.
- Realtime/queue/cache/stores: transports, events, Redis cluster, subscriptions, failure semantics.
- Security hardening: trust boundaries, snapshots, CSRF, auth policies, XSS, CSP, upload scanning, safe HTML and incident response.
- CLI reference: every real command and flags with examples, outputs and troubleshooting.
- Architecture: dependency DAG, request sequence diagrams, extensibility API, lifecycle and protocol schemas.
- Testing: unit/integration/e2e security fixtures, fake clock, custom guards/actions and integration matrix.
- Deploy: standalone Node, Docker, reverse proxy, multiple replicas, SSR process, Redis, CSP/security headers, asset CDN; Windows local dev.
- Recipes: counters, forms, CRUD, admin, email, charts, auth, uploads, search, pagination, job progress, SaaS multi-tenancy, realtime, progressive offline, AI stream.
- Migration/versioning, public extension API, troubleshooting, known limitations, upstream compatibility.

### 22.4 Open-source community docs

CONTRIBUTING with local setup and conventional commit/Changesets, CODE_OF_CONDUCT, GOVERNANCE, maintainership/decision process, SUPPORT, SECURITY disclosure, LICENSE (default MIT or Apache-2.0 selected via ADR; honor dependency licenses), CHANGELOG, ROADMAP, ADR index, templates for bug reports/security and feature proposals, community extension guidelines and compatibility promises. Configure real GitHub workflows only with actual required secrets; do not invent URLs/accounts.

### 22.5 Docs verification

Lint Markdown, check internal links, run code snippets/types, build docs site, screenshot key docs pages/visual regressions if site exists, ensure every package README is included in npm tarball, verify all CLI snippets against actual CLI `--help`. Site must not depend on production API keys or unpublished packages after pack install.

---
## 23. MANDATORY PHASED EXECUTION PLAN — IMPLEMENT TO COMPLETION

**Do not interpret phases as opportunities to request approval.** Execute them sequentially (parallelize independent tasks internally). Record each phase in `docs/implementation/STATUS.md` with scope, commits, decisions, tests and evidence. Do not proceed past a blocking red quality gate without fixing it. Avoid rushing to later features with broken foundations. The end state is every required production feature delivered, not merely a roadmap.

Every phase has: (1) architecture detail and task breakdown; (2) implementation; (3) negative tests and browser/integration tests; (4) docs; (5) cross-package verification; (6) static/security checks; (7) user-facing runnable sample; (8) final acceptance checklist.

### PHASE 0 — Workspace audit, source-of-truth, reproducible development

**Tasks**

0.1 Inspect current working directory, git status, current packages, existing ownership, constraints and tools; preserve work.
0.2 Confirm project brand Nestvexa; check registry names/scope ownership (do not publish), domain/org availability only if tools allow, license compatibility, package names as proposed.
0.3 Inspect current upstream official docs and source on supported NestJS, Inertia v3, Livewire v4 inspiration, Alpine, Node LTS, TypeScript, Vite, HBS and security standards. Write factual compatibility table.
0.4 Select npm publish layout, module format, Nest execution integration strategy, state snapshot method, client morph strategy, template adapter interface and SSR boundaries. Capture ADRs and threat model.
0.5 Set up pnpm monorepo, TypeScript strict, ESLint, Prettier, tests, browser tooling, CI, Changesets, precommit hooks and reproducible lockfile.
0.6 Create scripts `build`, `test`, `test:unit`, `test:integration`, `test:e2e`, `test:security`, `test:compat`, `test:pack`, `lint`, `typecheck`, `format:check`, `docs:build`, `bench`, `release:check`; scripts actually run, not placeholders.
0.7 Build a **feature ledger** `docs/implementation/feature-ledger.md` with every requirement ID from this prompt, package, priority, implementation link, tests link, docs link, status, blocker. Start all marked pending. Automate a missing-evidence check.
0.8 Create risk register (high: DI/guards parity, hydration integrity, DOM ownership, upstream Inertia v3, security), issue severity criteria, recovery plan and dependency audit.

**Exit gate**: clean install on at least Linux (and Windows runner/host if available), baseline lint/typecheck/test/docs tasks work, starter Nest app boots without Nestvexa, ADRs reviewed, all requirements tracked; no fake empty success scripts.

### PHASE 1 — Fundamental core and default Handlebars MVC

**Tasks**

1.1 Implement `@nestvexa/core`, config schema, DI tokens, forRoot/forRootAsync, registries, plugin extension contracts, logging and HTTP adapters.
1.2 Implement `@nestvexa/views`: engine registry, safe HTML, layouts/partials/slots, view helpers/composers, namespaces, resolution, cache and capability API.
1.3 Implement complete `@nestvexa/engine-hbs`; integrate Nest's existing `@Render` and MVC patterns without replacing them.
1.4 Implement actual default distribution `nestvexa` including HBS and Alpine client dependency metadata, but do not enable incomplete reactive endpoints yet. Ship coherent initialization semantics.
1.5 Test trusted HTML injection API, unsafe HTML escaping, template traversal, layouts/partials, dev view reload and production precompile/caching.
1.6 Build working `examples/starter-hbs` with multi-page layout, nav links, welcome page, API coexistence, form fallback.
1.7 Add Express and Fastify tests and version/prefix/session middleware compatibility cases.
1.8 Author root quickstart draft and package READMEs; verify `npm pack` and clean installs.

**Exit gate**: a brand-new external Nest app imports packed Nestvexa and renders secure HBS page/layout with assets. No frontend framework dependencies included. Existing Nest API route unaffected.

### PHASE 2 — Live server protocol, component lifecycle, core state and security

**Tasks**

2.1 Define and implement live protocol schema, validation, errors and golden vector tests; design signatures/server-side token mode and version semantics.
2.2 Register decorated live components via Nest modules; validated unique names; correct DI resolution across scopes.
2.3 Implement `@State`, `@Action`, `@Computed`, `@Locked` and basic hooks with explicit serialization/exposure policies.
2.4 Implement secure initial component embedding in HBS, opaque component identity, signed/owned snapshot or store references, request endpoint versioning.
2.5 Implement real live action dispatch with Nest-compatible guards/pipes/interceptors/filters and request context, scoped provider guarantees, full authorization tests. Explicitly avoid metadata-only execution.
2.6 Implement server rerender and response envelope with correct state/snapshot revision; client requests cannot select template paths or arbitrary method names.
2.7 Add CSRF/origin/size/rate/tenant control foundations before generalizing features.
2.8 Unit/property-based tests, two-user concurrency, forged snapshots, method guessing, invalid writable paths and injected service leak tests.
2.9 Build real Live counter demo with CLI or manual bootstrap; e2e click changes count without full document reload.
2.10 Document Live state/action lifecycle and security defaults.

**Exit gate**: secured live counter with one users' state isolated from another, guards demonstrably executing, tampered/expired snapshots rejected, real browser interaction and no recompilation/runtime warnings.

### PHASE 3 — Alpine integration, safe directives and DOM morph engine

**Tasks**

3.1 Build browser client bootloader/runtime package and wire Alpine once. Provide `$live` API and cleanup.
3.2 Implement DOM morphing while preserving state/focus/selection/scroll/file-input safety and nested component boundaries. Write visual/browser regression fixtures.
3.3 Implement `nv:click`, `nv:submit`, `nv:model` with modifiers, `nv:loading`, `nv:dirty`, `nv:text`, `nv:bind`, `nv:cloak`, `nv:ignore`, `nv:replace`, `nv:ref`, `nv:show`.
3.4 Implement safe directive grammar/parser, strict action identifiers, no eval, targeted updates and event delegation.
3.5 Request scheduler, debounce/throttle, deduplication, concurrency ordering, cancellation, retries only if safe, stale response discard, DOM lifecycle hooks.
3.6 Playwright test each directive with keyboard, mouse, forms, browser back/forward, Alpine state preservation and nested mutations.
3.7 Add performance instrumentation, bundle analysis and CSP test page.

**Exit gate**: user writes HBS and decorators to build a reactive form/table; Alpine local UI and DOM state survive updates; prototype/XSS and stale request tests pass.

### PHASE 4 — Full Live feature parity foundation

**Tasks**

4.1 Implement `@Url`, `@Session`, `@Reactive`, `@Modelable`, event decorators and parent/child component isolation.
4.2 Implement nested components, mount keys, lifecycle hooks full set, per-component computed invalidation, explicit typed synthesizers for complex state.
4.3 Implement `nv:init`, `nv:poll`, `nv:intersect`, `nv:offline`, `nv:confirm`, `nv:transition`, `nv:sort`, `nv:current`, `nv:stream`, `nv:navigate` with validated modifiers.
4.4 Implement lazy/deferred/island live rendering and placeholders, request bundling, isolated request option, progressive HTML form support, optional renderless actions.
4.5 Implement redirects, flash messages, downloads, pagination, navigation transitions and scroll/history restoration within compatible live pages.
4.6 Add controlled optimistic UI and well-defined rollback; anti-duplication and version conflict UX.
4.7 Browser test complex nested examples and all Live directive matrix rows; validate accessibility and production minified bundle behavior.
4.8 Write standalone docs for EVERY directive, lifecycle decorator, serialization capability, limitation and deployment caveat.

**Exit gate**: feature-ledger marks Live engine feature groups implemented + tested + documented with no major missing directive masquerading as shipped; full live-crud dashboard passes e2e.

### PHASE 5 — Forms, DTO/Zod validation, progressive rendering

**Tasks**

5.1 Build `@nestvexa/forms` state object, nested values, validation event protocol and schema adapters.
5.2 Integrate Nest DTO pipes/class-validator and optional Zod without silent validation bypass; maintain server authority.
5.3 Implement multi-step, async, debounce, reset/touched/dirty, autosave/drafts and conflict strategy.
5.4 Accessible error bags, screen reader notifications, focus management, no-JS fallback and submission redirect/flash.
5.5 Build register/login sample integrating a proper host-owned auth policy and a realistic CRUD editor.
5.6 Test type confusion, malformed/nested inputs, repeated submissions, cross-field errors, multiple forms and browser automation.

**Exit gate**: fully tested accessible live forms and no-JS fallback, typed DTO validation with forbidden/malformed input tests, docs and public APIs.

### PHASE 6 — Uploads and files

**Tasks**

6.1 Implement secure upload handler, temp token lifecycle, quotas, size/type/header validation, cleanup.
6.2 Implement progress/cancel, multiple, chunking/resume, safe finalization, downloads, content disposition.
6.3 Add optional S3-compatible storage adapter, tested against local integration service; direct upload signed URL flow.
6.4 Browser multipart/chunked tests; malicious file/path/mime/token/replay tests.
6.5 Integrate Live forms, fallback HTML forms, and Inertia adapters later; write storage and deploy docs.

**Exit gate**: secure full upload/download loop tested with local/S3-compatible providers and no required cloud secrets.

### PHASE 7 — Alternative template engines and view extensibility

**Tasks**

7.1 Implement EJS, Pug, Nunjucks adapters with clear feature capability flags and safe escaping strategies.
7.2 Ensure Live mount/render works for each engine **where supported** without requiring user to hand-escape framework markers; document engine-specific syntax and fallback boundaries.
7.3 Test layouts, slots/partials, helpers, namespaces, hot reload, caching, error line output and Windows filesystem behavior per engine.
7.4 Implement and document public custom engine plugin example; startup rejects unsupported capabilities helpfully.
7.5 CLI `add engine` commands install and configure correctly without breaking existing project.

**Exit gate**: every engine genuinely renders a sample Nest view and supported Live counter; compile/build/test in external consumer; unsupported engine features honestly declared.

### PHASE 8 — Full Inertia v3 Nest server adapter

**Tasks**

8.1 Build protocol-compatible `@nestvexa/inertia` adapter against verified v3 spec; initial HTML, XHR page objects, header rules and redirects.
8.2 Implement shared props/flash/errors, partial/optional/always/deferred/once/merged/deep-merged props, asset versioning, history flags, error bag handling and prop evaluation laziness.
8.3 Implement safe script-embedded JSON encoding, per-request auth checks, error handling, version mismatch and retry/fallback.
8.4 Add exhaustive protocol golden fixtures (derive expectations from official docs/upstream tests, not fabricated).
8.5 Test with representative official Inertia clients rather than only handcrafted HTTP requests.
8.6 Document protocol version and parity matrix, including client-owned features.

**Exit gate**: protocol conformance suite passes including edge responses, safe initial HTML and official client navigation. No dummy JSON-only adapter.

### PHASE 9 — React + Vite + SSR

**Tasks**

9.1 Implement `@nestvexa/react` integration using official `@inertiajs/react`.
9.2 Vite dev/hot reload, code splitting, SSR and hydration build, manifest injection, CSP, error boundaries.
9.3 React starter app with nested layout, link/navigation, forms, validation, partial reloads, shared/deferred props, uploads, optimistic UI using official patterns.
9.4 Typed page props, route links and optional universal action hook; verify server authorization and per-page rendering.
9.5 Playwright e2e in dev and production; packed external app install.

**Exit gate**: genuine working React Inertia app with SSR where supported and fully functional navigation/forms, no duplicate React versions and no API-only workaround.

### PHASE 10 — Vue + Vite + SSR

**Tasks**

10.1 Implement official Vue client integration including plugin setup, Vue SSR/hydration and Vite manifest.
10.2 Vue starter with same functional features as React path and Vue-native forms/composables.
10.3 Type-safe page props, named app roots, optional universal actions; test standalone and alongside React routes.
10.4 Test SSR hydration, prod build, form/partial props/redirect, browser navigation.

**Exit gate**: genuine standalone Vue Inertia app and mixed Nest backend (React + Vue routes) pass and bundle separation is proven.

### PHASE 11 — Svelte + Vite + SSR

**Tasks**

11.1 Implement official Svelte Inertia client, current Svelte SSR/hydrate API and Vite setup.
11.2 Svelte starter covers navigation, forms, validation, deferred props, uploads, versioning and fallbacks.
11.3 Test standalone, full SSR, prod build and cross-route full-page navigation with React/Vue/HBS.

**Exit gate**: genuine Svelte Inertia app passes full browser tests; Nest host serves HBS/live/React/Vue/Svelte routes concurrently with no conflict.

### PHASE 12 — Hybrid islands and universal actions

**Tasks**

12.1 Implement islands registry, build-time allowed imports, bundle manifests, mount modes, safe prop bridge, DOM boundaries and cleanup.
12.2 Implement HBS shell containing React, Vue and Svelte islands plus independent Live component, local island event bus, SSR/hydration where supported, streaming/placeholder strategy.
12.3 Implement `@nestvexa/actions` server registry, guards/DTO validation, typed metadata, route exposure policy, concurrency/idempotency/streaming results.
12.4 Build TypeScript action client generator and framework-specific hooks/composables; test both type generation and runtime authorization.
12.5 Test hybrid morph retention, dynamic removal, navigation fallback, unauthorized actions, HMR and production bundles.
12.6 Write complete hybrid/action architecture docs and migration/compatibility details.

**Exit gate**: hybrid dashboard real browser demo and typed action invoked from HBS/React/Vue/Svelte with authorization. Cross-root transitions are graceful full navigations when appropriate.

### PHASE 13 — Realtime, Redis, state stores, caches and jobs

**Tasks**

13.1 Implement polling/SSE/WebSocket transport negotiation, subscription authorization, resilience and server push.
13.2 Optional Redis broker and state store, multi-replica integration, quotas, per-tenant channels, event ordering semantics.
13.3 Optional render/data cache adapters, correct invalidation/keys, privacy controls, render graph with declared dependencies.
13.4 Optional job queue integration and progress/cancel/retry components with real queue worker sample.
13.5 Stress and fault tests: Redis outage, server restarts, disconnected users, expired session, high load, slow clients, tenant isolation.
13.6 Document deployment topologies, exact broker guarantees, and cost/backpressure caveats.

**Exit gate**: live dashboard works in single-process and two-process Redis integration test; job progress correct; no cross-tenant broadcast/data leak.

### PHASE 14 — Advanced UX, accessibility, offline, i18n, theming

**Tasks**

14.1 Implement Progressive Enhancement fallback patterns, read-only cache, optional local draft storage, reconnect/overdue action handling; do not replay unsafe actions.
14.2 Implement optional i18n and RTL integration, locale-safe caches, translated forms and validation, date/number formatting.
14.3 Provide accessible unstyled UI primitives and optional component theme including modal, table, combobox, tabs, forms, sort, toast and job progress.
14.4 Integrate feature flag-aware rendering, optional AI streaming adapter and human approval workflow extension (no provider key needed for core tests).
14.5 Test keyboard, WCAG automated checks, low-bandwidth/offline simulation, hydration/RTL/cross-locale, dark/reduced-motion and user logout clears sensitive drafts.

**Exit gate**: representative admin product can run RTL and accessibility scenarios, offline workflows documented/secure; optional extensions are real, testable and not default dependencies.

### PHASE 15 — CLI, starter kits, generators, DevTools, observability

**Tasks**

15.1 Implement every declared CLI command fully; identify unsupported commands as explicit errors with docs until implemented, not pretend to complete.
15.2 Create HBS, EJS, React, Vue, Svelte, hybrid, multi-tenant, realtime and upload starter generators. All generated projects strict-build and pass tests.
15.3 Build component/form/action/resource generators, typed route/action codegen, validation and conflict-safe file edits.
15.4 Build `nestvexa doctor` and `inspect` commands; support Windows and standard CI environments.
15.5 Implement production-disabled devtools panel, request/action/morph traces, optional browser extension source/build if feasible as a separately verified deliverable.
15.6 OpenTelemetry and structured logs redacted; profiling/bundle analysis and render budgets.
15.7 Docs for extensions, maintenance and testing recipes.

**Exit gate**: `npx nestvexa init` in fresh Nest app yields HBS/Alpine/live app, optional `add react/vue/svelte` works, every generated template is runnable and its `--help` command truthful.

### PHASE 16 — Ecosystem hardening, integrations, stability tests

**Tasks**

16.1 Upgrade current stable dependency patches after compatibility checks; run full Node/Nest/Express/Fastify/browser/renderer engine matrix.
16.2 Pack every package and install in a temporary external project using npm and pnpm to catch workspace-only dependencies, bad exports, missing assets and wrong peer ranges.
16.3 Fuzz/parsers/state/serializer/directives/inertia headers; run all attacks and permission matrix. Resolve all P0/P1 issues.
16.4 Load test, memory leak stress, performance baseline against original benchmarks; fix regressions or document and adjust evidence-backed budgets via ADR.
16.5 Review accessibility, localization/RTL, browser compatibility, SSR hydration, CSP, source map leaking, unsafe defaults.
16.6 Test forward/backward migrations; public type and protocol golden file diff; release candidate stabilization.
16.7 Add complete contributing and extension examples; invite future community work via plugin contracts and clear code ownership, not unreviewed remote plugins.

**Exit gate**: zero known release-blocking issues, full test matrices green or explicit gap marked blocker, no circular package imports, clean package packed install, reproducible build, security design review logged, documentation accurate.

### PHASE 17 — Publication preparation & final handoff (DO NOT publish automatically)

**Tasks**

17.1 Finalize root and EVERY package README, docs website, examples, reference pages, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `CHANGELOG.md`, supported versions, migration/version policy and extension SDK.
17.2 `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm test:security`, `pnpm test:compat`, `pnpm build`, `pnpm docs:build`, `pnpm test:pack`, `pnpm release:check` (or exact real scripts if adjusted).
17.3 Build publish artifacts for all packages, run `npm pack --dry-run` with tarball inspection; check `exports`, peers, license, binary entry points, CI provenance/configuration and package signatures as supported.
17.4 Verify LICENSE/third-party notices, no secrets, npm package names/scope restrictions, SPDX, security scan, API review, accurate statuses and semver version plan (prefer initial release candidate such as 0.1.0-rc.x if ecosystem remains young, but do not misstate maturity).
17.5 Prepare Changesets/publish order, GitHub release notes, issue templates, version changelogs, tag strategy, `npm publish --access public` **as documented future owner-authorized command only**.
17.6 Produce `docs/implementation/FINAL_RELEASE_REPORT.md` with feature evidence, open issues, coverage, performance, security findings, tested versions, artifacts/packages and EXACT manual steps for owner to authorize publishing, add registry token, ensure ownership, tag and trigger release workflow.
17.7 Report project completion only if acceptance checklist and all required features pass. Otherwise report **precisely which items are incomplete and why**; do not substitute enthusiastic language for evidence.

**Exit gate**: the owner could review tarballs/README and authorize a reproducible CI-driven publication with minimal final human steps; actual npm publication remains unperformed without permission.

---

## 24. FEATURE LEDGER — MANDATORY TRACKABLE ITEMIZATION

Create one row per item and subitem in Sections 4–22 and phases 0–17, assigning IDs and preserving status across sessions. The following groups must not be lost between architectural abstraction and coding:

| Group | Feature IDs | Non-negotiable coverage |
| --- | --- | --- |
| Core and integrations | CORE-001… | Nest module, config, DI scopes, guards, pipes, interceptors, filters, routing, HTTP adapters |
| MVC/engine | VIEW-001… | HBS default, EJS/Pug/Nunjucks, escape, layouts, helpers, composers, safe HTML, custom adapters |
| Live protocol | PROT-001… | schema, snapshots, signatures, state store, tenancy, session, expiry, replay, revision, error codes |
| Live components | LIVE-001… | state/actions/computed/hooks/nested/lazy/defer/isolation/session/URL/reactive/modelable/locked/events |
| Directives | DIR-001… | every `nv:*` directive plus modifier and cleanup tests |
| Browser runtime | BROW-001… | Alpine, client boot, CSP, morph, focus, navigation, request schedule, bundles, error UX |
| Forms | FORM-001… | DTO/Zod, validation, nested, wizard, async, drafts, accessible error bags, no-JS fallback |
| Uploads | UP-001… | local/S3, chunk, progress, limits, safe finalization, downloads |
| Inertia | INERT-001… | full verified v3 protocol, all required page metadata, redirects, partial/deferred/once, validation/SSR |
| React/Vue/Svelte | SPA-001… | three independent official adapters, Vite/SSR/browser e2e, mixed backend |
| Hybrid | ISLAND-001… | ownership, mount/unmount, manifests, prop escape, event bridge, SSR, mixed browser tests |
| Server actions | ACT-001… | explicit registry, Nest auth pipeline, typed generation and clients, idem/concurrency |
| Realtime | REAL-001… | polling/SSE/WS, Redis, presence, authorization, reconnect, scalable transports |
| Stores/cache/jobs | DATA-001… | memory/Redis state, private cache, invalidation/graph, queues/job progress |
| I18n/offline/UI/AI | EXT-001… | RTL, progressive/controlled offline, accessible UI kit, AI streaming safe extension |
| CLI/DevTools | DX-001… | init, add, generators, inspect/doctor, devtools, typed routes, production safeguards |
| Security | SEC-001… | ASVS matrix, CSRF, XSS, origin, authorizations, uploads, tenants, replay, secrets, logging |
| Testing/perf | QA-001… | unit/contract/integration/e2e/chaos/browser/pack/benchmark/a11y |
| Docs/community | DOC-001… | every package README, guides, API docs, examples, ADR, license/governance/security |
| Release | REL-001… | verified tarballs, pack consumers, metadata, release scripts, changelogs, manual ownership steps |

**Ledger schema:** `ID | requirement | priority | package | implementation files | test files | docs | example | security notes | state(Pending/InProgress/Blocked/Done) | validation evidence | outstanding issues`.

Feature completion audit must detect gaps (missing files/tests/docs, invalid links, unimplemented commands, TODO stubs). Feature ledger updates after each phase and is included in final handoff. Do not mark optional future features complete if they have only interfaces. If keeping an optional extension outside initial release, it is an explicit unmet requirement under this request unless genuinely implemented and verified; do not disguise it as a planned future feature.

---

## 25. RELEASE-BLOCKING DEFINITION OF DONE

Before presenting Nestvexa as finished and ready for owner-controlled publishing, verify **EVERY** statement with evidence:

### Functionality

- [ ] Default `npm install nestvexa` and `npx nestvexa init` work in a fresh Nest app with HBS/Alpine/live, with actual tarball install and valid namespace permissions caveat.
- [ ] All documented engine adapters have runnable examples and honest capability checks.
- [ ] All exposed Live decorators/hooks and all declared directives/modifiers actually function in browser.
- [ ] Secure Live requests do not bypass Nest auth/guard/validation/DI semantics.
- [ ] Forms, validation, redirects, upload/download, lazy/defer, nested components, navigation, offline and progressive fallbacks work to documented boundaries.
- [ ] Genuine official Inertia v3 client integrations for React, Vue and Svelte, including verified key protocol features.
- [ ] One backend serves HBS, live, React, Vue, Svelte, islands and native REST simultaneously.
- [ ] Universal typed server actions work cross-adapter with protected exposure/authorization.
- [ ] Realtime transports and distributed Redis example function, including private tenant channels.
- [ ] Optional state stores/cache/jobs/i18n/UI/AI extensions are real if shipped as packages.
- [ ] Every CLI command, generator, DevTools feature and starter named as shipped is operational.

### Security and reliability

- [ ] Threat model and mapped OWASP ASVS 5 requirements exist and are reviewed.
- [ ] CSRF/XSS/state tampering/unauthorized actions/mass assignment/tenant isolation/upload attacks/unsafe redirects test suite green.
- [ ] Untrusted state is bounded and validated, nonsecret snapshots are never misrepresented as private.
- [ ] Revisions, concurrency, stale browser response and idempotency policies tested.
- [ ] No leaked secrets/credentials/PII in logs, examples or package tarballs.
- [ ] No known P0/P1 vulnerabilities, no CI-disabled security suites, no dependency critical advisories ignored without justified mitigation.
- [ ] Fault injection, graceful disconnect/reconnect and distributed state tests green.

### Maintainability

- [ ] Strict TS, lint/format, architectural boundary/cycle checks, public API stability tests green.
- [ ] Required coverage/property/mutation and protocol compatibility evidence present.
- [ ] No fake interfaces exposed as implemented, no TODO stubs in release paths, no skipped meaningful tests.
- [ ] No circular runtime deps, backend/browser leakage, unintended global side effects or wrong peer dependencies.
- [ ] Reproducible lockfile, idempotent CLI, Windows/Linux developer workflow, supported Node/Nest/TypeScript matrix documented.

### Distribution and docs

- [ ] Every real package has accurate install/usage/exports/peer README, docs, examples and version strategy.
- [ ] Root README includes accurate package topology and a fully working copy-paste quickstart.
- [ ] Docs site links and tested snippets pass; troubleshooting/deployment/security/contributing docs complete.
- [ ] `npm pack` tarballs include licenses/README/runtime JS/types/assets and exclude secrets/tests where not needed.
- [ ] Clean external project install and production build run with no monorepo alias dependencies.
- [ ] CI workflows, Changesets/changelogs, release checks, package ownership verification instructions and release notes ready.
- [ ] `FINAL_RELEASE_REPORT.md` reports all executed commands with success/failure evidence, timings/coverage metrics and remaining human actions.

If any box fails, **continue implementing or identify a genuine blocker**. Never declare completion based on subjective confidence. No one can logically guarantee perfect code or the absence of undiscovered bugs; demonstrate measurable readiness instead.

---

## 26. VERIFICATION COMMANDS, TEST ARTIFACTS, AND CI PIPELINE

Create these actual or equivalently named scripts, document their exact behavior, and execute them:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:contracts
pnpm test:security
pnpm test:e2e
pnpm test:compat
pnpm test:accessibility
pnpm test:pack
pnpm docs:build
pnpm release:check
```

Add `pnpm test:all` running complete mandatory validation. A frozen lockfile install is required after lockfile generated; initial bootstrap can use non-frozen first install. CI examples:

- Pull request: install/lint/typecheck/unit/contracts/critical integration/security smoke/build/docs/pack consumer test.
- Nightly: browser compatibility matrix, full security suite, fuzz/chaos, load/performance/long-memory, optional package permutations, upstream dependency check.
- Release candidate: all checks, full Nest major/Node LTS/Express/Fastify/browser matrix, bundled examples, SBOM/audit, artifact integrity, semver/API-diff, provenance readiness.
- Release workflow: publish **only on explicit owner-controlled tag/manual approval**, use npm provenance/OIDC trusted publishing if available and configured, least privilege, rollback/deprecation guide, release notes and package ordering.

Store machine-readable results `artifacts/reports/*` and human-readable summary in `docs/implementation/FINAL_RELEASE_REPORT.md`, with captured package versions, tested environments and timestamp. If tools/network/services unavailable, state untested coverage as blocked and do not stamp ready prematurely.

---

## 27. QUALITY OF EXAMPLES — THE REQUIRED 'REAL APPLICATION' DEMO

Create a realistic, coherent **Nestvexa Showcase Application** rather than unrelated trivial counters only. Use an example domain (e.g., team project/order management) with seeded non-sensitive sample data and host-owned auth/roles.

Required pages:

1. Public HBS landing and search-friendly catalog with layout, SEO, i18n/RTL switch.
2. Live CRUD board with search, sorting, pagination, filters, nested modals, confirmation, form validation, file attachments, toast, partial updates and optimistic safe changes.
3. Multi-step profile setup with draft, autosave, server validation and no-JS fallback.
4. React Inertia admin page with SSR, props, errors, forms and navigation.
5. Vue Inertia analytics page with partial/deferred props and a chart.
6. Svelte Inertia activity page with navigation, validation and SSR.
7. HBS hybrid dashboard containing a React chart, Vue feed, Svelte widget and Live notification component; demonstrate safe independent updates.
8. Authorized realtime notifications/job progress and user presence with a two-instance Redis test.
9. Secure uploaded image/document flow using local storage and optional S3 adapter.
10. Native Nest REST endpoint and optionally one GraphQL operation showing Nestvexa does not interfere.
11. Separate guest/member/admin roles, at least two tenants, and negative tests proving no cross-account leaks.
12. Graceful empty/loading/error/offline/network-failure states, keyboard support, focus management and screen reader output.

Seed/reset scripts and Docker Compose for optional Redis/S3-compatible test systems. No reliance on real paid services. Provide screenshots only when generated from actual running application, not fabricated mockups presented as test evidence.

---

## 28. ARCHITECTURE INSPECTION / REVIEW QUESTIONS TO RESOLVE IN CODE

Before closing each phase, answer these with concrete files/tests:

- Does each public decorator invoke working runtime behavior or merely record metadata?
- Is every live action run through the correct Nest request-scoped DI and auth pipeline?
- Can two logged-in users or two tenants update the same component identifier without data leakage?
- Can a browser craft arbitrary state paths, object prototypes, component names, template paths or method names?
- Are snapshot signatures canonical, bound, expiring and revocable? What prevents old signed state replay for important mutations?
- Does a signed browser snapshot accidentally contain sensitive services/session data?
- Does CSRF work with real cookie authentication, not just an HTTP header check?
- Can HBS/EJS/Pug/Nunjucks escaping be bypassed by untrusted interpolations or custom helpers?
- Does Inertia initial page JSON prevent script closing injection and satisfy exact current upstream v3 protocol?
- Do deferred/optional/once props actually defer evaluation, or are they eagerly loaded?
- Can three framework islands coexist without double ownership or hydration mismatch?
- Does HBS morphing preserve keyboard input, focus and local Alpine state? What happens on nested removal?
- Can safe actions be type-generated and invoked from every frontend adapter in packed external apps?
- Can a detached/slow client, cancelled request, expired session, or backend restart cause duplicate irreversible effects?
- Do redis pub/sub, cache tags, jobs and tenant channels isolate identities and survive reconnections appropriately?
- Is the default install lightweight, free of required SPA frameworks/S3/Redis/ORM deps, and easy to operate?
- Does `npm pack` include every actual binary, browser asset and `.d.ts`, while excluding repository-only files?
- Can an external developer follow each README from scratch without hidden workspace aliases or unpublished registry URLs?
- Are claimed performance improvements measured against honest baselines on equivalent hardware?
- Do docs accurately distinguish stable, experimental, optional, unsupported and future features?

Any 'No', 'unknown', or 'untested' on critical requirement becomes a tracked issue before release.

---

## 29. MAINTENANCE, LONG-TERM UPGRADABILITY, COMMUNITY CONTRIBUTIONS

Build Nestvexa to be maintained by a future community rather than one giant tangled codebase.

### 29.1 Public extension SDK

- Stable typed plugin interface for view engines, state synthesizers, action policies, storage, caching, realtime transports, island renderers, CLI generators, instrumentation, and UI kits.
- Explicit versioned capability contracts; plugin compatibility checks at bootstrap, informative errors instead of silent breakage.
- Hook order and lifecycle documented; plugin sandbox/trust assumptions stated. Third-party plugins run code with application privileges unless sandboxed by separate proven system.
- Minimal third-party example package outside monorepo proving adapter use from published tarballs.
- No import from private `src/internal/*` paths; public interfaces and API extraction checks.

### 29.2 Community governance

- Small PRs, conventional commits, tests/docs with behavior changes, clear review ownership, security reporting, RFC/ADR process for new features, compatibility policy, release cadence and deprecation windows.
- Good first issues can be suggested, but do not mark unfinished mandatory features as good-first-issue replacements for delivery.
- CI issue/PR templates require reproduction, supported platform, migration notes, security/privacy/performance implications, tests.
- Automated dependency updates with test matrix, no unreviewed auto-merges of runtime-critical packages.

### 29.3 Forward compatibility

- Keep Live Protocol versioned and client/runtime semver-aware; reject unsupported major protocol with useful reload/migration flow.
- Adapter capability negotiation and independent package versioning policy; avoid fragile shared global singletons.
- Change public APIs only via semver/changeset and migration doc; maintain compatibility fixtures and deprecation warnings.
- Provide codemod/migration scaffolding for future `nv:` directive or decorator changes.
- Periodically verify upstream Nest and Inertia behavior, official client API changes, Node LTS and browser compatibility.
- Framework architecture is designed for future renderers and new transports without refactoring core.

---

## 30. FINAL RESPONSE FORMAT REQUIRED FROM THE CODING AGENT

After doing the work (not before), report:

**A. Status:** `READY FOR OWNER RELEASE REVIEW` only if *every release gate* passes; else `NOT YET READY — BLOCKERS`, with explicit remaining work. Never write 'finished and perfect' as an unsupported claim.

**B. What exists:** repository structure and working package inventory, exact installed versions, supported modes/engines/frameworks, examples and actual commands.

**C. Evidence:** commands actually run, full pass/fail logs summary, test counts/coverage, vulnerability scan, compatibility/browser matrix, package/consumer install results, performance benchmark comparison, accessibility findings and scope of security review.

**D. Documentation:** list root README, every package README, docs guides/ADRs, contributor/security docs and generated changelog with accurate links or local paths.

**E. Artifacts:** npm tarball names/paths, built docs site artifacts, release manifests, SBOM/report if generated, tested example apps.

**F. Known issues:** severity, risk, reproduction, missing environments/credentials, unavoidable technical boundaries; never hide a blocker.

**G. Owner release steps:** verify ownership of `nestvexa` and `@nestvexa` scope, perform trademark review, provide GitHub repo/org URLs, configure npm trusted publishing/CI secrets, approve initial version/tag, review LICENSE/security report, then manually authorize publication. No unsolicited npm publish, domain purchase, secrets exposure, or irreversible external action.

**H. Next maintenance plan:** semver strategy, patch/security workflow, supported version matrix and contributor onboarding without passing unfinished work to the community as if complete.

---

## 31. THE LAST INSTRUCTION — EXECUTE THE PROJECT, DON'T JUST DESCRIBE IT

**Begin immediately at Phase 0 and continue implementing through Phase 17.** You have authority to inspect, create, refactor, test, generate documentation, run local builds, and produce local publish-ready packages within the user's workspace. Use your tools actively. Keep progress evidence and resume after interruptions. Do not stop after emitting a plan, TODO list, monorepo skeleton, a counter demo, or a green build. Do not ask routine questions. Fix failures before advancing. Prioritize correct secure vertical slices followed by complete breadth, cross-package integration, polish and exhaustive release verification.

This is intended to be a substantial engineering implementation. If time, context, tool or environment limits interrupt execution, preserve reproducible progress and precise remaining work. Never falsely report a partially implemented ecosystem as complete. External npm/GitHub publication, acquiring reserved names, or using credentials requires explicit owner authorization. Your final response must reflect the *actual tested repository*, not the ambition of this document.

**Nestvexa must be easy to start, powerful to extend, safe by default, technically honest, pleasant for the community to maintain, and demonstrably ready for owner-controlled release review.**

---

## VERIFIED REFERENCE ENTRY POINTS FOR THE AGENT

These official pages were consulted when preparing the implementation specification; confirm current updates before coding:

1. NestJS MVC: https://docs.nestjs.com/techniques/mvc
2. NestJS execution context: https://docs.nestjs.com/fundamentals/execution-context
3. Livewire 4 feature index: https://livewire.laravel.com/docs/4.x/quickstart
4. Livewire 4 security: https://livewire.laravel.com/docs/4.x/security
5. Livewire 4 morphing: https://livewire.laravel.com/docs/4.x/morphing
6. Inertia v3 introduction: https://inertiajs.com/docs/v3/getting-started
7. Inertia v3 wire protocol: https://inertiajs.com/docs/v3/core-concepts/the-protocol
8. Inertia v3 SSR: https://inertiajs.com/docs/v3/advanced/server-side-rendering
9. Alpine.js: https://alpinejs.dev/
10. OWASP ASVS: https://asvs.owasp.org/

*Reference to Livewire is feature inspiration, not a statement of code compatibility; reference to Inertia is for implementing its documented protocol with official clients. Nestvexa is an independent open-source project, subject to licenses, version checks, trademark rights and npm naming availability.*
