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
| Inertia | Nest controller → page object / initial HTML → official Inertia client                        | `@nestvexa/inertia`                                      |
| Hybrid  | HBS/Live pages with nested Live children; framework islands are in progress                   | `@nestvexa/live`                                         |
| API     | REST and other Nest endpoints are untouched                                                   | —                                                        |

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

| Package                                                     | Purpose                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [nestvexa](packages/nestvexa/README.md)                     | Default distribution: core + views + HBS + Live + client + Alpine assets; `nestvexa` bin |
| [@nestvexa/core](packages/core/README.md)                   | Configuration, module, registries, capability contracts                                  |
| [@nestvexa/views](packages/views/README.md)                 | Engine contracts, `SafeHtml`, rendering registry                                         |
| [@nestvexa/engine-hbs](packages/engine-hbs/README.md)       | Handlebars adapter                                                                       |
| [@nestvexa/live](packages/live/README.md)                   | Live components: generated Nest routes, bound state, nesting, events, effects            |
| [@nestvexa/client](packages/client/README.md)               | Browser runtime (one ESM bundle, 48 KiB gzip budget)                                     |
| [@nestvexa/alpine](packages/alpine/README.md)               | Alpine `$live` bridge and CSP startup                                                    |
| [@nestvexa/inertia](packages/inertia/README.md)             | Inertia v3 server adapter (optional)                                                     |
| [@nestvexa/forms](packages/forms/README.md)                 | Validation adapters (Zod, class-validator), hardening, no-JS forms (optional)            |
| [@nestvexa/uploads](packages/uploads/README.md)             | Streaming uploads, tokens, quotas, S3 SigV4, downloads (optional)                        |
| [@nestvexa/realtime](packages/realtime/README.md)           | SSE/WebSocket/polling invalidation, Redis-protocol broker, jobs (optional)               |
| [@nestvexa/cache](packages/cache/README.md)                 | Privacy-scoped cache with tags and single flight (optional)                              |
| [@nestvexa/observability](packages/observability/README.md) | Tracing spans, metrics, redacted logs, devtools (optional)                               |
| [@nestvexa/cli](packages/cli/README.md)                     | `nestvexa` command line                                                                  |

Optional packages are never pulled in by the default install. Alternative template
engines, universal server actions, React/Vue/Svelte adapters with Vite/SSR, islands,
i18n and the UI kit are being integrated; see status.

## Runnable examples

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @nestvexa/example-starter-hbs start     # http://127.0.0.1:3100 MVC
pnpm --filter @nestvexa/example-live-counter start    # http://127.0.0.1:3101 Live counter
pnpm --filter @nestvexa/example-starter-live start    # http://127.0.0.1:3102
pnpm --filter @nestvexa/example-inertia-basic start   # http://127.0.0.1:3103 Inertia + React client
pnpm --filter @nestvexa/example-auth-forms start      # http://127.0.0.1:3104 forms and auth starter
pnpm --filter @nestvexa/example-uploads start         # http://127.0.0.1:3105 uploads
```

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
