# Nestvexa

**Build full-stack. Stay in Nest.**

Nestvexa is a TypeScript-first full-stack application layer for NestJS: ordinary
Handlebars MVC, Livewire-style server-driven **Live** components with an Alpine
bridge, an Inertia v3 server adapter for official React/Vue/Svelte clients, secure
forms and uploads, authorized realtime invalidation and a CLI. It extends Nest
controllers, modules, DI, guards, pipes, interceptors and filters rather than
replacing them.

> **Status: experimental alpha (0.1.0-alpha.0), not release-ready.** Nothing has been
> published to npm. Implemented features are tested as described below; remaining
> gaps are tracked in [implementation status](docs/implementation/STATUS.md) and the
> [feature ledger](docs/implementation/feature-ledger.md).

## Architecture at a glance

| Mode    | Flow                                                                                          | Package(s)                                               |
| ------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| MVC     | Nest controller → `@Render()` → HBS view → HTML                                               | `nestvexa`, `@nestvexa/views`, `@nestvexa/engine-hbs`    |
| Live    | Registered component → server render → browser runtime → authorized actions → keyed DOM morph | `@nestvexa/live`, `@nestvexa/client`, `@nestvexa/alpine` |
| Inertia | Nest controller → page object / initial HTML → official React, Vue or Svelte client (SSR)     | `@nestvexa/inertia`, `@nestvexa/react                    | vue | svelte` |
| Hybrid  | HBS/Live pages with nested Live children and allowlisted React/Vue/Svelte islands             | `@nestvexa/live`, `@nestvexa/islands`                    |
| API     | REST endpoints are untouched; typed universal server actions are opt-in                       | `@nestvexa/actions`                                      |

The core kernel imports no renderer, browser or framework code; boundaries are
enforced by `scripts/boundaries.mjs`. See the [architecture overview](docs/architecture/overview.md)
and [dependency graph](docs/architecture/package-dependency-graph.md).

## Quick start (existing Nest app)

Inside a NestJS (Express) project, once the packages are installed from the
tarballs built by `pnpm test:pack` or from a registry:

```sh
npm install nestvexa
npm install --save-dev @nestvexa/cli
npx nestvexa init        # adds views/, src/nestvexa/*, patches app.module.ts and main.ts
npm install
npm run start            # open /nestvexa
```

`nestvexa init` wires HBS, a Live counter, Alpine startup and a guest-session
security policy you must replace before production. It is idempotent and supports
`--dry-run`. CommonJS Nest apps work on Node 22.12+ through `require(esm)`. See the
[CLI reference](docs/reference/cli.md).

## MVC and Live in code

```ts
@Module({
  imports: [
    NestvexaModule.forRoot(
      { views: { root: 'views', layout: 'layout' }, live: { enabled: true } },
      {
        components: [Counter],
        useFactory: () => ({ origin, resolveIdentity, authorize }),
      },
    ),
  ],
})
export class AppModule {}

@LiveComponent({ name: 'counter', view: 'counter' })
export class Counter {
  @State() count = 0;
  @Computed() get doubled() {
    return this.count * 2;
  }
  @Action() increment() {
    this.count++;
  }
}
```

```hbs
<output>{{count}}</output> <button nv:click='increment'>+</button>
```

Call `await configureNestvexa(app)` before `app.listen()` and put `{{nvScripts}}` in
the layout. Directives (`nv:click`, `nv:submit`, `nv:model.*`, `nv:loading`,
`nv:poll`, `nv:navigate`, `nv:optimistic`, `nv:sort`, `nv:stream` and more) are
data-only grammar — no expressions are evaluated. See the
[directive reference](docs/reference/directives.md), [nested components](docs/guides/nested-components.md),
[effects](docs/guides/live-effects.md), [lifecycle](docs/guides/live-lifecycle.md) and
[default setup](docs/guides/default-live-setup.md).

## Packages

| Package                                                         | Purpose                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [nestvexa](packages/nestvexa/README.md)                         | Default distribution: core + views + HBS + Live + client + Alpine assets; `nestvexa` bin |
| [@nestvexa/core](packages/core/README.md)                       | Configuration, module, registries, capability contracts                                  |
| [@nestvexa/views](packages/views/README.md)                     | Engine contracts, `SafeHtml`, rendering registry                                         |
| [@nestvexa/engine-hbs](packages/engine-hbs/README.md)           | Handlebars adapter                                                                       |
| [@nestvexa/live](packages/live/README.md)                       | Live components: generated Nest routes, bound state, nesting, events, effects            |
| [@nestvexa/client](packages/client/README.md)                   | Browser runtime (one ESM bundle, 48 KiB gzip budget)                                     |
| [@nestvexa/alpine](packages/alpine/README.md)                   | Alpine `$live` bridge and CSP startup                                                    |
| [@nestvexa/inertia](packages/inertia/README.md)                 | Inertia v3 server adapter (optional)                                                     |
| [@nestvexa/forms](packages/forms/README.md)                     | Validation adapters (Zod, class-validator), hardening, no-JS forms (optional)            |
| [@nestvexa/uploads](packages/uploads/README.md)                 | Streaming uploads, tokens, quotas, S3 SigV4, downloads (optional)                        |
| [@nestvexa/engine-ejs](packages/engine-ejs/README.md)           | EJS adapter (optional)                                                                   |
| [@nestvexa/engine-pug](packages/engine-pug/README.md)           | Pug adapter (optional)                                                                   |
| [@nestvexa/engine-nunjucks](packages/engine-nunjucks/README.md) | Nunjucks adapter (optional)                                                              |
| [@nestvexa/actions](packages/actions/README.md)                 | Authorized universal server actions and typed client generation (optional)               |
| [@nestvexa/vite](packages/vite/README.md)                       | Vite manifest tags, static serving, dev server and SSR bundles (optional)                |
| [@nestvexa/react](packages/react/README.md)                     | Official `@inertiajs/react` boot and SSR entry helpers (optional)                        |
| [@nestvexa/vue](packages/vue/README.md)                         | Official `@inertiajs/vue3` boot and SSR entry helpers (optional)                         |
| [@nestvexa/svelte](packages/svelte/README.md)                   | Official `@inertiajs/svelte` (Svelte 5) boot and SSR helpers (optional)                  |
| [@nestvexa/islands](packages/islands/README.md)                 | Allowlisted React/Vue/Svelte islands with explicit DOM ownership (optional)              |
| [@nestvexa/i18n](packages/i18n/README.md)                       | Locale negotiation, ICU-style catalogs, Intl formatting, RTL helpers (optional)          |
| [@nestvexa/ui](packages/ui/README.md)                           | Unstyled accessible HBS/Live primitives with keyboard module and theme (optional)        |
| [@nestvexa/ai](packages/ai/README.md)                           | Provider-neutral streaming chat with server-enforced tool approval (optional)            |
| [@nestvexa/flags](packages/flags/README.md)                     | Server-enforced feature flags: guard, view and Live policy helpers (optional)            |
| [@nestvexa/offline](packages/offline/README.md)                 | Identity-scoped drafts, read-only snapshots, safe reconnect (optional)                   |
| [@nestvexa/realtime](packages/realtime/README.md)               | SSE/WebSocket/polling invalidation, Redis-protocol broker, jobs (optional)               |
| [@nestvexa/cache](packages/cache/README.md)                     | Privacy-scoped cache with tags and single flight (optional)                              |
| [@nestvexa/observability](packages/observability/README.md)     | Tracing spans, metrics, redacted logs, devtools (optional)                               |
| [@nestvexa/cli](packages/cli/README.md)                         | `nestvexa` command line                                                                  |

Optional packages are never pulled in by the default install; frameworks (React, Vue,
Svelte, Vite, template engines) are peer dependencies. `scripts/boundaries.mjs`
enforces these rules. See [STATUS.md](docs/implementation/STATUS.md) for verification status.

## Runnable examples

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @nestvexa/example-starter-hbs start     # http://127.0.0.1:3100 MVC
pnpm --filter @nestvexa/example-live-counter start    # http://127.0.0.1:3101 Live counter
pnpm --filter @nestvexa/example-starter-live start    # http://127.0.0.1:3102
pnpm --filter @nestvexa/example-inertia-basic start   # http://127.0.0.1:3103 Inertia + React client
pnpm --filter @nestvexa/example-auth-forms start      # http://127.0.0.1:3104 forms and auth starter
pnpm --filter @nestvexa/example-uploads start         # http://127.0.0.1:3105 uploads
pnpm --filter @nestvexa/example-inertia-react start   # http://127.0.0.1:3106 React + Vite (SSR: start:ssr)
pnpm --filter @nestvexa/example-inertia-vue start     # http://127.0.0.1:3107 Vue + Vite SSR
pnpm --filter @nestvexa/example-inertia-svelte start  # http://127.0.0.1:3108 Svelte + Vite SSR
pnpm --filter @nestvexa/example-inertia-mixed start   # http://127.0.0.1:3109 React, Vue and Svelte in one host
pnpm --filter @nestvexa/example-admin-i18n start      # http://127.0.0.1:3110 i18n/RTL admin, UI kit, AI, flags
pnpm --filter @nestvexa/example-actions-basic start   # http://127.0.0.1:3111 universal server actions
pnpm --filter @nestvexa/example-hybrid-dashboard start # http://127.0.0.1:3112/hybrid Live + islands
pnpm --filter @nestvexa/example-custom-engine start   # http://127.0.0.1:3113 EJS/Pug/Nunjucks
pnpm --filter @nestvexa/example-starter-ejs start     # http://127.0.0.1:3114 EJS MVC + Live
pnpm --filter @nestvexa/example-live-crud start       # http://127.0.0.1:3115/tasks Live CRUD
pnpm --filter @nestvexa/example-realtime-dashboard start # http://127.0.0.1:3116 SSE dashboard
pnpm --filter @nestvexa/example-upload-to-s3 start    # http://127.0.0.1:3117 S3 uploads (needs S3_* env)
pnpm --filter @nestvexa/example-multi-tenant start    # http://127.0.0.1:3119 tenants and roles
pnpm --filter @nestvexa/example-express-host start    # http://127.0.0.1:3120 same app on Express
pnpm --filter @nestvexa/example-fastify-host start    # http://127.0.0.1:3121 same app on Fastify
pnpm --filter @nestvexa/example-offline-progressive start # http://127.0.0.1:3122 offline/no-JS
pnpm --filter @nestvexa/example-integration-matrix start  # http://127.0.0.1:3123 every renderer in one server
```

Every example has a README (what it shows, how to run it, security notes) and a
Playwright spec under `tests/browser/` with an axe accessibility check. The
names in the planned repository layout map to these directories:

| Planned name                    | Example                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter-hbs`                   | [starter-hbs](examples/starter-hbs/README.md) (MVC) and [starter-live](examples/starter-live/README.md) (default Live setup)                                                                                                    |
| `starter-ejs`                   | [starter-ejs](examples/starter-ejs/README.md)                                                                                                                                                                                   |
| `live-counter`                  | [live-counter](examples/live-counter/README.md)                                                                                                                                                                                 |
| `live-crud`                     | [live-crud](examples/live-crud/README.md); a smaller board is `/projects` in starter-live                                                                                                                                       |
| `auth-forms`                    | [auth-forms](examples/auth-forms/README.md)                                                                                                                                                                                     |
| `inertia-react/vue/svelte`      | [inertia-react](examples/inertia-react/README.md), [inertia-vue](examples/inertia-vue/README.md), [inertia-svelte](examples/inertia-svelte/README.md); all three in one host: [inertia-mixed](examples/inertia-mixed/README.md) |
| `hybrid-dashboard`              | `examples/hybrid-dashboard` (`/hybrid`, Live + React/Vue/Svelte islands)                                                                                                                                                        |
| `realtime-dashboard`            | [realtime-dashboard](examples/realtime-dashboard/README.md)                                                                                                                                                                     |
| `upload-to-s3`                  | [upload-to-s3](examples/upload-to-s3/README.md); local-disk storage: [uploads](examples/uploads/README.md)                                                                                                                      |
| `multi-tenant`                  | [multi-tenant](examples/multi-tenant/README.md)                                                                                                                                                                                 |
| `express-host` / `fastify-host` | [express-host](examples/express-host/README.md) / [fastify-host](examples/fastify-host/README.md) (one shared `app.ts`)                                                                                                         |
| `offline-progressive`           | [offline-progressive](examples/offline-progressive/README.md)                                                                                                                                                                   |
| `integration-matrix`            | [integration-matrix](examples/integration-matrix/README.md)                                                                                                                                                                     |
| `apps/playground`               | Not a separate app: [integration-matrix](examples/integration-matrix/README.md) is the one-server playground                                                                                                                    |

The Live starter contains `/board`, `/team` (nested components), `/projects` (CRUD
board: search, sort, pagination, validation, events, optimistic UI, downloads),
`/activity` (URL/session state, observers, sort, streams) and `/realtime`
(cross-session SSE refresh and job progress).

## Security model

- Live actions run through real generated Nest routes: origin and CSRF checks,
  host identity and `authorize(identity, component, action)`, then your guards,
  pipes, interceptors and filters.
- State lives server-side in an identity-bound store with revision locks; browser
  snapshots are opaque references, not secrets, and replays return `409`.
- Writable state is an explicit allowlist with validation; `@Locked`/default state is
  read-only but is **not** authorization.
- Templates escape by default; Live fragments reject scripts, inline handlers and
  executable URLs before morphing.
- Uploads, downloads, realtime tokens and events are identity-bound; event payloads
  and optimistic projections are treated as untrusted.

See [hardening](docs/security/hardening.md), the [threat model](docs/security/threat-model.md)
and [SECURITY.md](SECURITY.md). Hosts own authentication, sessions, cookies, CSP and
deployment policy.

## Verification

```sh
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test                 # vitest (unit/integration/security, real Nest apps)
pnpm test:e2e             # Playwright: Chromium, Firefox, WebKit
pnpm test:pack            # tarballs + external npm/pnpm consumers (run from PowerShell on Windows)
pnpm size:check && pnpm docs:build && pnpm ledger:check
pnpm checkpoint:check     # all of the above plus coverage, bench, audit and release:check
```

`release:check` intentionally fails while mandatory acceptance work remains.
Linux execution, real Redis/S3/ClamAV services and load tests have not been run.

## Project

[Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Security](SECURITY.md) ·
[Support](SUPPORT.md) · [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) ·
[ADRs](docs/adr/) · [License (MIT)](LICENSE). Registry scope ownership, maintainer
identity and official URLs are owner-supplied release prerequisites.
