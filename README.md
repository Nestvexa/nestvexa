# Nestvexa

[![CI](https://github.com/Nestvexa/nestvexa/actions/workflows/ci.yml/badge.svg)](https://github.com/Nestvexa/nestvexa/actions/workflows/ci.yml)

**Build full-stack. Stay in Nest.**

Nestvexa is a TypeScript-first full-stack application layer for NestJS: ordinary
Handlebars MVC, Livewire-style server-driven **Live** components with an Alpine
bridge, an Inertia v3 server adapter for official React/Vue/Svelte clients, secure
forms and uploads, authorized realtime invalidation and a CLI. It extends Nest
controllers, modules, DI, guards, pipes, interceptors and filters rather than
replacing them.

> **Status: experimental alpha (0.1.0-alpha.0), not release-ready.** Nothing has been
> published to npm. Implemented features are tested as described below; remaining
> gaps are listed under [known limitations](#known-limitations) and tracked in the
> [feature ledger](docs/implementation/feature-ledger.md).

## Architecture at a glance

| Mode    | Flow                                                                                          | Package(s)                                                                    |
| ------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| MVC     | Nest controller → `@Render()` → HBS view → HTML                                               | `nestvexa`, `@nestvexa/views`, `@nestvexa/engine-hbs`                         |
| Live    | Registered component → server render → browser runtime → authorized actions → keyed DOM morph | `@nestvexa/live`, `@nestvexa/client`, `@nestvexa/alpine`                      |
| Inertia | Nest controller → page object / initial HTML → official React, Vue or Svelte client (SSR)     | `@nestvexa/inertia`, `@nestvexa/react`, `@nestvexa/vue` or `@nestvexa/svelte` |
| Hybrid  | HBS/Live pages with nested Live children and allowlisted React/Vue/Svelte islands             | `@nestvexa/live`, `@nestvexa/islands`                                         |
| API     | REST endpoints are untouched; typed universal server actions are opt-in                       | `@nestvexa/actions`                                                           |

The core kernel imports no renderer, browser or framework code; boundaries are
enforced by `scripts/boundaries.mjs`. See the [architecture overview](docs/architecture/overview.md)
and [dependency graph](docs/architecture/package-dependency-graph.md).

## Documentation

Start with [getting started](docs/getting-started/README.md), which has one page per
mode: MVC, Live, Inertia (React, Vue or Svelte), hybrid islands and API. Then read
the [tutorials](docs/tutorials/README.md) (a CRUD app, realtime, uploads and
deployment) and the [recipes](docs/recipes/README.md) (auth, tenant scoping, file
upload, realtime dashboard, an Inertia page with a Live island, fragment caching,
job progress, an offline-safe form). When something fails, see
[troubleshooting](docs/troubleshooting/README.md).

| Topic                 | Guide                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forms and validation  | [forms](docs/guides/forms.md)                                                                                                                                      |
| Uploads and downloads | [uploads](docs/guides/uploads.md)                                                                                                                                  |
| Realtime and jobs     | [realtime](docs/guides/realtime.md)                                                                                                                                |
| Inertia and SSR       | [Inertia](docs/guides/inertia.md), [Vite and SSR](docs/guides/vite.md)                                                                                             |
| Islands               | [islands](docs/guides/islands.md), [coexistence](docs/guides/coexistence.md)                                                                                       |
| Server actions        | [server actions](docs/guides/server-actions.md)                                                                                                                    |
| Caching               | [caching](docs/guides/caching.md)                                                                                                                                  |
| Production build      | [deployment](docs/deployment/README.md), [CSP and headers](docs/deployment/csp-and-headers.md)                                                                     |
| Security              | [security guide](docs/security/guide.md), [hardening](docs/security/hardening.md)                                                                                  |
| Testing               | [testing guide](docs/testing/guide.md)                                                                                                                             |
| Migration             | [from Nest MVC](docs/migration/from-nest-mvc.md), [from Livewire](docs/migration/from-livewire.md), [from Inertia/Laravel](docs/migration/from-inertia-laravel.md) |

All guides are in [docs/guides](docs/guides/). The [feature matrix](docs/feature-matrix.md)
shows what is shipped, partial or missing. `pnpm build && pnpm docs:build` builds
the documentation site into `artifacts/docs`, including an API reference generated
from every package's type declarations ([site README](apps/docs/README.md)). The
site is not hosted publicly yet. Every TypeScript block in this README is a
provenance-checked excerpt of an example that is compiled and tested
([what the docs build checks](apps/docs/README.md#what-the-build-checks)).

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
`--dry-run`. CommonJS Nest apps work on Node 22.12+ through `require(esm)`. The
output of the CLI is committed as the [cli-generated example](examples/cli-generated/README.md)
(browser test: `tests/browser/cli-generated.spec.ts`).

## MVC hello world

An ordinary Nest controller rendering a Handlebars view, from
[starter-hbs](examples/starter-hbs/README.md) (`tests/browser/mvc.spec.ts`):

<!-- snippet: examples/starter-hbs/src/main.ts -->

```ts
@Controller()
class HomeController {
  @Get()
  @Render('home')
  home() {
    return {
      title: 'Nestvexa',
      message: 'Build full-stack. Stay in Nest.',
      example: '<script>alert("escaped")</script>',
    };
  }
```

<!-- snippet: examples/starter-hbs/src/main.ts -->

```ts
@Module({
  imports: [
    NestvexaModule.forRoot({
      views: {
        root: fileURLToPath(new URL('../views', import.meta.url)),
        layout: 'layouts/main',
      },
    }),
  ],
  controllers: [HomeController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await configureNestvexa(app);
```

Values are escaped by default, so the `example` string renders as text.

## Live components

The component `nestvexa make:component` generates, from
[cli-generated](examples/cli-generated/README.md):

<!-- snippet: examples/cli-generated/src/nestvexa/components/counter.component.ts -->

```ts
@LiveComponent({ name: 'counter', view: 'components/counter' })
export class CounterComponent {
  @State() count = 0;

  @Action() increment(): void {
    this.count++;
  }
}
```

<!-- snippet: examples/cli-generated/views/components/counter.hbs -->

```hbs
<section aria-label="Counter">
  <p>Count: <output aria-live="polite">{{count}}</output></p>
  <button type="button" nv:click="increment" nv:loading.attr="disabled">
```

The host decides who the caller is and which actions they may run; nothing is
allowed by default:

<!-- snippet: examples/cli-generated/src/nestvexa/nestvexa.config.ts -->

```ts
export const liveActions: Record<string, readonly string[]> = {
  counter: ['$mount', 'increment'],
```

<!-- snippet: examples/cli-generated/src/nestvexa/nestvexa.config.ts -->

```ts
  useFactory: (realtime: RealtimeService) => ({
    origin: process.env['NESTVEXA_ORIGIN'] ?? 'http://localhost:3000',
    resolveIdentity: liveIdentity,
    authorize: (_identity: LiveIdentity, component: string, action: string) =>
      liveActions[component]?.includes(action) ?? false,
```

A controller mounts it with `await this.live.mount(CounterComponent, request)`
([welcome.controller.ts](examples/cli-generated/src/nestvexa/welcome.controller.ts)).
Call `await configureNestvexa(app)` before `app.listen()` and put `{{nvScripts}}` in
the layout. Directives (`nv:click`, `nv:submit`, `nv:model.*`, `nv:loading`,
`nv:poll`, `nv:navigate`, `nv:optimistic`, `nv:sort`, `nv:stream` and more) are
data-only grammar: no expressions are evaluated. See the
[directive reference](docs/reference/directives.md).

**Lifecycle in one paragraph.** A mount runs boot, URL/session hydration, `mount`,
`dehydrate`, `beforeRender`, the view, `afterRender` and `dispose`, then commits
the snapshot. An action restores the snapshot and runs boot, `hydrate`,
`beforeUpdate`/`afterUpdate` per assigned field, `beforeAction`, the action,
`afterAction`, `dehydrate`, the render hooks and `dispose`. Origin, CSRF, identity,
authorization and revision checks happen before a component is created. Details:
[lifecycle](docs/guides/live-lifecycle.md), [nested components](docs/guides/nested-components.md),
[effects](docs/guides/live-effects.md), [default setup](docs/guides/default-live-setup.md).

## Inertia

A Nest controller returns props for an official Inertia v3 client, from
[inertia-basic](examples/inertia-basic/README.md) (`tests/browser/inertia.spec.ts`):

<!-- snippet: examples/inertia-basic/src/main.ts -->

```ts
  @Get('users')
  @InertiaPage('Users/Index')
  index() {
    return { users: () => users.map((user) => ({ ...user })) };
  }
```

<!-- snippet: examples/inertia-basic/client/app.tsx -->

```tsx
void createInertiaApp({
  resolve: (name) => {
    if (!isPage(name)) throw new Error(`Unknown page ${name}`);
    return pages[name];
  },
  setup({ el, App, props }) {
    createRoot(el).render(<App {...props} />);
  },
});
```

`InertiaModule.forRoot` takes the asset `version`, `share`, `shareOnce` and an
`errorPage` component; props support `defer`, `optional`, merge and once
semantics; Precognition and SSR through `@nestvexa/vite` are supported. CSRF for
the official client is host-owned (the example's `XsrfGuard`). See
[Inertia](docs/getting-started/inertia.md) and [the Inertia guide](docs/guides/inertia.md),
which also cover Vue and Svelte.

## Islands

Allowlisted React, Vue or Svelte islands in server-rendered pages, from
[islands-vite](examples/islands-vite/README.md) (`tests/browser/islands-vite.spec.ts`).
Props are validated against a closed schema and signed:

<!-- snippet: examples/islands-vite/src/island-definitions.ts -->

```ts
  {
    id: 'counter-react',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/islands/counter-react.tsx',
    budgetBytes: 80_000,
    props: counterProps,
  },
```

<!-- snippet: examples/islands-vite/src/main.ts -->

```ts
      this.registry.renderSsr(
        'counter-react',
        { label: 'React clicks', start: 1 },
        { label: 'React counter', context },
      ),
```

DOM ownership is explicit: the framework owns its island root, and Live morphing
and Alpine never touch it. Do not put Live directives or Alpine inside an island,
and keep an island out of markup that Live replaces unless it is under
`nv:ignore`. See [islands](docs/guides/islands.md) and
[hybrid pages](docs/getting-started/hybrid.md).

## Server actions

Typed, authorized RPC for any page, from [actions-basic](examples/actions-basic/README.md)
(`tests/actions-http.test.ts`, `tests/browser/actions.spec.ts`):

<!-- snippet: examples/actions-basic/src/cart.ts -->

```ts
@ActionGroup('cart')
@UseGuards(SessionAuthGuard)
export class CartActions {
  constructor(@Inject(CartService) private readonly cart: CartService) {}

  @ServerAction({ id: 'add-item', idempotent: true, concurrency: 'serial' })
  add(
    @ActionInput(AddItemPipe) input: AddItemInput,
    @ActionContext() context: ActionContext,
  ): CartSummary {
    // The owner always comes from the host-resolved identity, never the body.
    return this.cart.add(context.identity.subject, input);
  }
```

The browser calls the client generated by `nestvexa-actions-codegen`; each call
resolves to the server's return type (`CartSummary`):

<!-- snippet: examples/actions-basic/browser/main.ts -->

```ts
document.getElementById('clear-cart')?.addEventListener('click', () => {
  void run(() => actions.cart.clear(), '');
});
```

Defaults: `POST` with `application/json` only, an exact `Origin` match, a
constant-time CSRF check, declared size and body depth limits, identity from
`resolveIdentity` (never the body) and deny-by-default `authorize`, then your Nest
guards and pipes ([actions security model](packages/actions/README.md#security-model)).

## CLI

`nestvexa --help` (from [`@nestvexa/cli`](packages/cli/README.md)) lists:

| Command                                                                             | Purpose                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `init`                                                                              | Wire HBS views, Live and Alpine into a Nest app                |
| `doctor [--production]`, `check`                                                    | Check Node, Nest, peers, engines, CSRF, secrets and assets     |
| `add engine <hbs\|ejs\|pug\|nunjucks>`                                              | Add a template engine                                          |
| `add <react\|vue\|svelte\|inertia>`                                                 | Inertia root with its own Vite build                           |
| `add <islands\|forms\|actions\|realtime\|redis\|uploads\|i18n\|devtools\|cache>`    | Add and wire an optional package                               |
| `add plugin <package>`, `remove <feature>`                                          | Wire an installed extension; remove unmodified generated files |
| `make:component`, `make:page`, `make:layout`, `make:form`, `make:action`            | Generators                                                     |
| `make:policy`, `make:resource`, `make:island`, `make:test`                          | Generators                                                     |
| `templates`, `templates:eject <id>`                                                 | List or customize generator templates                          |
| `inspect:routes`, `inspect:components`, `inspect:actions`, `routes:types [--check]` | Inspect the app; typed route map and helpers                   |
| `build`, `migrate [--revert <id>]`                                                  | Project build; versioned project migrations                    |

Options include `--dry-run`, `--json`, `--force`, `--install` and `--cwd`. Each
`add` command adds the package to `package.json` and generates its wiring;
`--install` also runs the package manager. Every command and flag, with the
generated folder layout, is in the [CLI reference](docs/reference/cli.md);
`pnpm docs:build` fails if that page documents a command `nestvexa --help` does
not list.

## Packages

All packages are ESM. **Node** is the package's `engines` range; CI tests Node 22
and 24 on Ubuntu and Windows. **Nest** is the `@nestjs/common` peer range; only Nest
12.2.0 is installed and tested. Code that runs in the **browser** is tested with
Playwright 1.64 in Chromium, Firefox and WebKit; no minimum browser versions are
defined.

| Package                                                         | Purpose                                                                                         | Node            | Nest    | Runs in                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------- | ------- | ---------------------- |
| [nestvexa](packages/nestvexa/README.md)                         | Default distribution: core + views + HBS + Live + client + Alpine assets; `nestvexa` bin        | ^22.13 \|\| ^24 | ^12.0.0 | server (serves assets) |
| [@nestvexa/core](packages/core/README.md)                       | Configuration, module, registries, capability contracts                                         | >=22            | ^12.0.0 | server                 |
| [@nestvexa/views](packages/views/README.md)                     | Engine contracts, `SafeHtml`, rendering registry                                                | >=22            | —       | server                 |
| [@nestvexa/engine-hbs](packages/engine-hbs/README.md)           | Handlebars adapter                                                                              | >=22            | —       | server                 |
| [@nestvexa/live](packages/live/README.md)                       | Live components: generated Nest routes, bound state, nesting, events, effects                   | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/client](packages/client/README.md)                   | Browser runtime (44 KiB gzip entry, on-demand chunks, 60 KiB gzip in total)                     | >=22            | —       | browser                |
| [@nestvexa/alpine](packages/alpine/README.md)                   | Alpine `$live` bridge and CSP startup (Alpine ~3.17.5)                                          | ^22.13 \|\| ^24 | —       | browser                |
| [@nestvexa/inertia](packages/inertia/README.md)                 | Inertia v3 server adapter (optional)                                                            | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/forms](packages/forms/README.md)                     | Validation adapters (Zod, class-validator), hardening, no-JS forms (optional)                   | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/uploads](packages/uploads/README.md)                 | Streaming uploads, tokens, quotas, S3 SigV4, downloads (optional)                               | ^22.13 \|\| ^24 | ^12.0.0 | server + browser       |
| [@nestvexa/engine-ejs](packages/engine-ejs/README.md)           | EJS adapter (optional)                                                                          | >=22            | —       | server                 |
| [@nestvexa/engine-pug](packages/engine-pug/README.md)           | Pug adapter (optional)                                                                          | >=22            | —       | server                 |
| [@nestvexa/engine-nunjucks](packages/engine-nunjucks/README.md) | Nunjucks adapter (optional)                                                                     | >=22            | —       | server                 |
| [@nestvexa/actions](packages/actions/README.md)                 | Authorized universal server actions and typed client generation (optional)                      | ^22.13 \|\| ^24 | ^12.0.0 | server + browser       |
| [@nestvexa/vite](packages/vite/README.md)                       | Vite manifest tags, static serving, dev server and SSR bundles (optional; Vite ^8)              | ^22.13 \|\| ^24 | —       | server                 |
| [@nestvexa/react](packages/react/README.md)                     | Official `@inertiajs/react` boot and SSR entry helpers (optional; React ^19)                    | ^22.13 \|\| ^24 | —       | browser + SSR          |
| [@nestvexa/vue](packages/vue/README.md)                         | Official `@inertiajs/vue3` boot and SSR entry helpers (optional; Vue ^3.5)                      | ^22.13 \|\| ^24 | —       | browser + SSR          |
| [@nestvexa/svelte](packages/svelte/README.md)                   | Official `@inertiajs/svelte` (Svelte 5) boot and SSR helpers (optional)                         | ^22.13 \|\| ^24 | —       | browser + SSR          |
| [@nestvexa/islands](packages/islands/README.md)                 | Allowlisted React/Vue/Svelte islands with explicit DOM ownership (optional)                     | ^22.13 \|\| ^24 | —       | server + browser       |
| [@nestvexa/i18n](packages/i18n/README.md)                       | Locale negotiation, ICU-style catalogs, Intl formatting, RTL helpers (optional)                 | ^22.13 \|\| ^24 | ^12.0.0 | server + browser       |
| [@nestvexa/ui](packages/ui/README.md)                           | Accessible HBS/Live primitives, chart and fields, React/Vue/Svelte wrappers, theme (optional)   | ^22.13 \|\| ^24 | —       | server + browser       |
| [@nestvexa/ai](packages/ai/README.md)                           | Provider-neutral streaming chat with server-enforced tool approval (optional)                   | ^22.13 \|\| ^24 | ^12.0.0 | server + browser       |
| [@nestvexa/flags](packages/flags/README.md)                     | Server-enforced feature flags: guard, view and Live policy helpers (optional)                   | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/offline](packages/offline/README.md)                 | Identity-scoped drafts, read-only snapshots, allowlisted action queue (optional)                | ^22.13 \|\| ^24 | —       | browser + server       |
| [@nestvexa/mail](packages/mail/README.md)                       | Email templates through your view engine, provider-neutral transports, notifications (optional) | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/realtime](packages/realtime/README.md)               | SSE/WebSocket/polling invalidation, Redis-protocol broker, jobs (optional)                      | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/realtime-redis](packages/realtime-redis/README.md)   | Redis Live state store, presence, job queue and broker for multiple replicas (optional)         | ^22.13 \|\| ^24 | —       | server                 |
| [@nestvexa/cache](packages/cache/README.md)                     | Privacy-scoped cache with tags, single flight, render and fragment cache (optional)             | ^22.13 \|\| ^24 | —       | server                 |
| [@nestvexa/observability](packages/observability/README.md)     | Tracing spans, metrics, redacted logs, devtools (optional)                                      | ^22.13 \|\| ^24 | ^12.0.0 | server                 |
| [@nestvexa/cli](packages/cli/README.md)                         | `nestvexa` command line                                                                         | ^22.13 \|\| ^24 | —       | development            |

Optional packages are never pulled in by the default install; frameworks (React, Vue,
Svelte, Vite, template engines) are peer dependencies. `scripts/boundaries.mjs`
enforces these rules. Upstream versions and what has been tested are in
[upstream compatibility](docs/architecture/upstream-compatibility.md) and the
[test matrix](docs/contributing/test-matrix.md).

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
pnpm --filter @nestvexa/example-showcase start          # http://127.0.0.1:3124 the coherent showcase app
NESTVEXA_ASSETS=build PORT=3126 pnpm --filter @nestvexa/example-cli-generated start # CLI output only (see its README)
pnpm --filter @nestvexa/example-directive-lab start     # http://127.0.0.1:3360 Live directives under Trusted Types
pnpm --filter @nestvexa/example-islands-vite start      # http://127.0.0.1:3479 islands built with Vite (dev: HMR)
pnpm --filter @nestvexa/example-browser-lab start       # http://127.0.0.1:3860 navigation, Alpine $live, network loss
pnpm --filter @nestvexa/example-client-chunks start     # http://127.0.0.1:3880 on-demand Live client chunks, nonce CSP
pnpm --filter @nestvexa/example-api-coexistence start   # http://127.0.0.1:3885 REST, GraphQL, TCP microservice, WebSocket
PORT=3220 pnpm --filter @nestvexa/example-distributed-live start # one replica; REDIS_PORT=6379 for Redis mode (see its README)
pnpm --filter @nestvexa/example-data-cache start        # http://127.0.0.1:4000 render cache, custom Live store
pnpm --filter @nestvexa/example-orm-prisma start        # http://127.0.0.1:4020 Prisma (SQLite via libSQL)
pnpm --filter @nestvexa/example-orm-typeorm start       # http://127.0.0.1:4021 TypeORM (sql.js)
pnpm --filter @nestvexa/example-orm-drizzle start       # http://127.0.0.1:4022 Drizzle (libSQL)
pnpm --filter @nestvexa/example-auth-passport start     # http://127.0.0.1:4023 Passport auth starter
pnpm --filter @nestvexa/example-views-tour start        # http://127.0.0.1:4100 view namespaces, themes, error pages
pnpm --filter @nestvexa/example-devtools-tracing start  # http://127.0.0.1:4340 devtools panel, browser trace context, OpenTelemetry
```

`pnpm docs:build` fails when an `examples/*` workspace is missing from this
list.

Every example has a README (what it shows, how to run it, security notes) and a
Playwright spec under `tests/browser/` with an axe accessibility check. The
names in the planned repository layout map to these directories:

| Planned name                      | Example                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter-hbs`                     | [starter-hbs](examples/starter-hbs/README.md) (MVC) and [starter-live](examples/starter-live/README.md) (default Live setup)                                                                                                    |
| `starter-ejs`                     | [starter-ejs](examples/starter-ejs/README.md)                                                                                                                                                                                   |
| `live-counter`                    | [live-counter](examples/live-counter/README.md)                                                                                                                                                                                 |
| `live-crud`                       | [live-crud](examples/live-crud/README.md); a smaller board is `/projects` in starter-live                                                                                                                                       |
| `auth-forms`                      | [auth-forms](examples/auth-forms/README.md)                                                                                                                                                                                     |
| `inertia-react/vue/svelte`        | [inertia-react](examples/inertia-react/README.md), [inertia-vue](examples/inertia-vue/README.md), [inertia-svelte](examples/inertia-svelte/README.md); all three in one host: [inertia-mixed](examples/inertia-mixed/README.md) |
| `hybrid-dashboard`                | `examples/hybrid-dashboard` (`/hybrid`, Live + React/Vue/Svelte islands)                                                                                                                                                        |
| `realtime-dashboard`              | [realtime-dashboard](examples/realtime-dashboard/README.md)                                                                                                                                                                     |
| `upload-to-s3`                    | [upload-to-s3](examples/upload-to-s3/README.md); local-disk storage: [uploads](examples/uploads/README.md)                                                                                                                      |
| `multi-tenant`                    | [multi-tenant](examples/multi-tenant/README.md)                                                                                                                                                                                 |
| `express-host` / `fastify-host`   | [express-host](examples/express-host/README.md) / [fastify-host](examples/fastify-host/README.md) (one shared `app.ts`)                                                                                                         |
| `offline-progressive`             | [offline-progressive](examples/offline-progressive/README.md)                                                                                                                                                                   |
| `integration-matrix`              | [integration-matrix](examples/integration-matrix/README.md)                                                                                                                                                                     |
| `apps/playground`                 | Not a separate app: [integration-matrix](examples/integration-matrix/README.md) is the one-server playground                                                                                                                    |
| Showcase application (section 27) | [showcase](examples/showcase/README.md): one product app with auth, roles, two workspaces, Live dashboard and board, wizard, uploads, Vue Inertia, a Vue island and mail                                                        |

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
- **Tenants.** Resolve the tenant on the server from the authenticated session,
  never from a header, query or body the browser controls. Put it in every
  identity binding (Live `binding`, the action identity's tenant, uploads,
  realtime channel names, cache `vary` keys), or give the kernel request context
  a `resolveTenant` and enable `kernelIdentity` so MVC, Live, Inertia, actions,
  uploads and realtime see one server-resolved tenant. The
  [multi-tenant example](examples/multi-tenant/README.md) is the reference:
  `tests/multi-tenant-isolation.test.ts` checks cross-tenant and cross-user
  isolation over every transport and that a client-supplied tenant id is
  ignored. See [tenant isolation](docs/security/guide.md#tenant-isolation) and the
  [tenant scoping recipe](docs/recipes/tenant-scoping.md).

See [hardening](docs/security/hardening.md), the [threat model](docs/security/threat-model.md)
and [SECURITY.md](SECURITY.md). Hosts own authentication, sessions, cookies, CSP,
Node HTTP server timeouts and deployment policy.

## Verification

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm api:check
pnpm test                 # vitest (unit/integration/security, real Nest apps)
pnpm test:coverage        # the same run over sources with the coverage gate
pnpm test:e2e             # Playwright: Chromium, Firefox, WebKit
pnpm test:pack            # tarballs + external npm/pnpm consumers (run from PowerShell on Windows)
pnpm size:check && pnpm docs:build && pnpm ledger:check
pnpm checkpoint:check     # all of the above plus bench, audit and release:check
```

Robustness and performance have their own commands. The nightly workflow
(`.github/workflows/nightly.yml`) runs all four:

| Command              | What it does                                                            | Docs                                                                                          |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm test:property` | Property-based tests of the protocols, inputs and the browser runtime   | [property tests](docs/testing/property-load-mutation.md)                                      |
| `pnpm test:mutation` | StrykerJS over the highest-risk server modules; the score is not a gate | [mutation testing](docs/testing/property-load-mutation.md#mutation-testing-pnpm-testmutation) |
| `pnpm load`          | Load, soak and heap checks (recorded run 2026-11-05: 0 errors)          | [load and memory](docs/testing/property-load-mutation.md#load-and-memory-pnpm-load)           |
| `pnpm bench`         | Benchmarks against plain Nest and an official-style Inertia responder   | [benchmarks](docs/testing/benchmarks.md)                                                      |

`release:check` intentionally fails while mandatory acceptance work remains. A
Linux checkpoint (Ubuntu 24.04 in Docker) and the real-service suite
(`pnpm test:services`: Redis 7, SeaweedFS S3, ClamAV, and a two-replica Redis browser
run) have passed; see [STATUS.md](docs/implementation/STATUS.md).

Each package also has its own `test` script that runs that package's suites from the
root Vitest config, for example `pnpm --filter @nestvexa/cache test`. Build the package
and its dependencies first (`pnpm --filter @nestvexa/cache... build`), because the tests
import `dist`.

## Known limitations

- **Release status.** Alpha with no stability promise, including the extension
  API. No package is published to npm; install from the `pnpm test:pack`
  tarballs. There has been no independent security review (an owner action), and
  `pnpm release:check` fails until there is one.
- **Multiple replicas.** Live state, presence and durable jobs can be shared
  through `@nestvexa/realtime-redis` against a single Redis primary only: no
  Sentinel discovery, no tested failover, no Redis Cluster. Cross-replica Live
  idempotent replay is tested only against an in-process Redis test double, and a
  download URL is served only by the replica that issued it.
- **Process-local stores.** Server-action rate limits and serial locks, and
  pending upload tokens, have only in-memory implementations, so an upload must
  finish on the replica that started it. Action idempotency
  (`RedisActionIdempotencyStore`) and the cache (`RedisCacheStore`) have shared
  Redis stores in `@nestvexa/realtime-redis`. Action results do not stream
  (progress goes through jobs).
- **Browser runtime.** No teleports or portals (declined for 1.0); shadow DOM,
  iframes and multi-range selections are not supported by morphing. Alpine 3.17.x
  only. `nv:stream` streams text, not HTML fragments. Live and Inertia do not share
  one client-side navigation.
- **Testing depth.** The React, Vue and Svelte adapters, island hydration and the
  Alpine bridge have no property or fuzz suite, and the mutation score is not a
  gate. Load evidence is single-process on a busy laptop; two replicas plus Redis
  under load, SSR throughput and build times are not measured. Benchmarks show
  about three to five times the per-request cost of plain Nest, not yet profiled.
  No slow-header (slowloris) test covers the Live, actions or Inertia routes; Node's
  `headersTimeout` and `requestTimeout` are host-owned.
- **Accessibility.** Automated axe, reflow and forced-colors checks run; the
  manual screen-reader pass has not been executed. Forced-colors and layout-shift
  checks run in Chromium only.
- **Compatibility.** One version each of Nest 12 (12.2.0), React 19, Vue 3.5,
  Svelte 5 and Inertia 3.10 is tested; the rest of each peer range is untested.
  Packages are ESM; CommonJS hosts load them through Node 22.12+ `require(esm)`
  ([details](docs/architecture/package-dependency-graph.md#output-format)).
- **By design.** Live `layout`/`isolated` options and `@Layout`/`@Transition`
  are not provided ([ADR 0035](docs/adr/0035-live-layout-isolation-and-transitions.md)).
- **Documentation.** The site is built locally only; external links are not
  checked, and there are no screenshots and no translated quickstart.

Each package README's "Status and limits" section lists its own caveats. The
[feature matrix](docs/feature-matrix.md) and [roadmap](ROADMAP.md) list the rest.

## Project

[Contributing](CONTRIBUTING.md) (coding standards and commit rules) ·
[Governance](GOVERNANCE.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) ·
[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) ·
[Release process](docs/release/release-process.md) ·
[Versioning and deprecation](docs/release/versioning-and-deprecation.md) ·
[ADRs](docs/adr/) · [License (MIT)](LICENSE). Every package declares the GitHub
organization `Nestvexa` as maintainer. Review ownership is in
[CODEOWNERS](.github/CODEOWNERS). Registry scope ownership, individual maintainers and
official URLs are owner-supplied release prerequisites.
