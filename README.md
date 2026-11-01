# Nestvexa

The `/activity` starter also demonstrates [server-approved keyboard/native
sorting](docs/reference/nv-sort.md) and [authorized read-only text
streams](docs/reference/nv-stream.md). Streams use explicit host Nest routes and
registered endpoint IDs; their content is always text. See the
[instance-scope contract](docs/guides/component-instance-scope.md) for fresh
components sharing the correct request-scoped services. These additions do not
accept the remaining Phase 4 or Phase 5 requirements.

Phase 4 now includes URL/session state, request render/error/disposal hooks,
polling/intersection, visible/idle initialization and offline/current/transition
directives. Run the default Live starter and open `/activity` for a real flow.
See [URL/session state](docs/guides/url-session-state.md) and
[lifecycle order](docs/guides/live-lifecycle.md). Phase 4 remains in progress;
Phase 5 has not started. The public browser entry is now one minified ESM bundle;
[ADR 0015](docs/adr/0015-production-client-bundle.md) explains packaging and size.

Build full-stack. Stay in Nest.

Nestvexa is an in-development, TypeScript-first application layer for NestJS. This repository implements MVC, an initial secure Live slice and an isolated Alpine bridge from the [master specification](NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md). It is **not release-ready**. Full Live parity, Inertia, framework islands, universal actions, uploads, realtime, and CLI generators remain unmet requirements. No packages have been published by this project.

## Run the current implementation

Use Node 24 LTS and pnpm 10.26.1:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open `http://127.0.0.1:3100`. The example serves two Handlebars pages and `/api/health` through ordinary Nest controllers. No frontend framework is installed in the default distribution.

For the cookie-backed Live counter, run `pnpm --filter @nestvexa/example-live-counter start` after building, then open `http://127.0.0.1:3101`. It demonstrates actions, deferred/live/blur/change model binding, native draft reset, numeric and boolean validation, loading status, focus preservation and independent local DOM. See its [bootstrap and limitations](examples/live-counter/README.md) and [reset behavior](docs/guides/form-reset.md).

For the integrated default setup, run `pnpm --filter @nestvexa/example-starter-live start` and open `http://127.0.0.1:3102`. It uses one HBS engine for MVC and Live, `{{nvScripts}}` in its layout, and automatic CSP Alpine/client startup. See the [default Live guide](docs/guides/default-live-setup.md) for required host session and authorization policies.

Open `/board` in that starter for live search, keyed table sorting and a validated
form with keyboard submission and isolated Alpine notes. The
[Phase 3 acceptance review](docs/implementation/phase3-acceptance.md) records its
executed gate; this does not make the complete project release-ready. Advanced
manual client entries can opt into [redacted browser timings](docs/guides/client-diagnostics.md).

Phase 4 has begun with [awaited request/update hooks](docs/guides/live-update-hooks.md);
the work board displays the last accepted field through `afterUpdate`. The rest
of Phase 4 remains incomplete.

The board now includes [confirmed browser actions](docs/reference/nv-confirm.md):
native confirmation by default, with an optional typed asynchronous host dialog.
Cancellation/deadline/ownership cleanup is client presentation; the server still
authorizes every mutation. This example removes only session-bound public seeds.

Open `/init` for [eager initialization](docs/reference/nv-init.md) with loading
and retained Alpine state. `/init/denied` shows server denial without automatic
retry. Initialization also supports `.visible` and `.idle`; server-side deferred component creation remains unfinished Phase 4 work.

[Computed values](docs/guides/computed-values.md) support synchronous getters and
explicit async methods, with request/stage-local caching, state dependency keys,
TTL and bounded async waits. The startup panel renders its activity summary from
an async computed method; derived values remain outside writable state and actions.

The starter also demonstrates [keyboard focus after server updates](docs/guides/focus-restoration.md), including controls made disabled or hidden while a response is pending. This is scoped behavior verification; complete accessibility acceptance remains open.

Its [local editable example](docs/guides/focus-restoration.md#local-editable-selection) keeps retained caret/range positions through keyed reordering, without sending draft HTML as Live state. Plugin, cross-editor and replaced-node selections require their own host policy.

The Interests form binds [bounded multiple-select arrays](docs/guides/multiple-select.md) with strict item validation, shared aliases and native reset. Checkbox groups, files, nested models and the complete forms subsystem remain unimplemented.

```ts
import { Module } from '@nestjs/common';
import { NestvexaModule } from 'nestvexa';

@Module({
  imports: [
    NestvexaModule.forRoot({
      views: { root: 'src/views', layout: 'layouts/main' },
    }),
  ],
})
export class AppModule {}
```

Call `await configureNestvexa(app)` after creating the Nest app and before `app.listen()`. Controllers use Nest's existing `@Get()` and `@Render('home')` decorators. Async configuration uses `NestvexaModule.forRootAsync({ imports, inject, useFactory })`; file/environment configuration stays host-owned and explicit.

## Packages

| Package                                               | Implemented purpose                                        |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| [@nestvexa/core](packages/core/README.md)             | Configuration, module, registries and capability contracts |
| [@nestvexa/views](packages/views/README.md)           | Engine contracts, trusted HTML and rendering registry      |
| [@nestvexa/engine-hbs](packages/engine-hbs/README.md) | Handlebars adapter with filesystem containment             |
| [nestvexa](packages/nestvexa/README.md)               | Default distribution and Nest MVC bridges                  |

The Node packages are ESM-only and use legacy TypeScript decorators with `experimentalDecorators` and `emitDecoratorMetadata`. The exact dependency selection and tested environments are recorded in [upstream compatibility](docs/architecture/upstream-compatibility.md). Supported versions will only be advertised after their tests run.

The [@nestvexa/live](packages/live/README.md) package implements explicit generated Nest action routes and bound server-side state; [@nestvexa/client](packages/client/README.md) implements the corresponding browser transport and a small directive subset. The umbrella includes Live and re-exports its server API; activation requires a second root registration argument with component types and host security policies.

The umbrella includes the client, Alpine adapter and CSP distribution dependencies. Integrated Live registration serves their approved modules through content-addressed URLs and supplies an external boot module. Advanced hosts can use `browser.mode: 'manual'` or explicit `NestvexaAssetsModule.register()` from `nestvexa/assets`; the [asset guide](docs/guides/client-assets.md) covers that lower-level integration. Hosts always own sessions, identity and authorization. The core kernel remains independent of browser renderers.

The [@nestvexa/alpine](packages/alpine/README.md) adapter supplies `$live.call/get/set` to Alpine widgets inside an ignored Live subtree. The counter runs the actual Alpine CSP build with a restrictive script policy. See the [directive reference](docs/reference/directives.md) for the implemented grammar and remaining gaps.

## Safety and limitations

Ordinary `{{value}}` interpolation escapes HTML. Triple braces bypass escaping and are for framework-created layout fragments or trusted application markup only. Templates and helper functions are trusted application code. View names must come from server code. Host applications own authentication, cookies, CSRF for their routes, CSP, request limits, logging and deployment policy. Configuration flags alone do not install those controls. See [hardening](docs/security/hardening.md).

`live.enabled: true` requires an explicit registration, for example `NestvexaModule.forRoot(options, { components: [Counter], useFactory: () => ({ origin, resolveIdentity, authorize }) })`. Async host dependencies use the registration's `imports` and `inject`; renderer ownership stays with the umbrella. Both security flags remain required. Live state is JSON-only and stored in process memory with fixed expiry and revision locks; it is not a distributed transaction system. React, Vue, Svelte, Inertia, alternative engines, CLI and distributed transports are not implemented. The required command `npx nestvexa init` is not available yet.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
pnpm test:pack
pnpm test:node22
pnpm test:node24
pnpm size:check
pnpm docs:build
pnpm bench
pnpm release:check
```

The release check intentionally fails while mandatory acceptance work remains. `test:pack` creates tarballs and boots a real Nest app in a temporary external consumer. Reports go under `artifacts/reports`; documentation snapshots under `artifacts/docs`. The benchmark currently measures the HBS adapter only and is not a claim of full framework performance.

See [implementation status](docs/implementation/STATUS.md), [feature ledger](docs/implementation/feature-ledger.md), [contributing](CONTRIBUTING.md), [security policy](SECURITY.md), [changelog](CHANGELOG.md) and [license](LICENSE). Registry scope ownership, maintainer identity and official project URLs remain owner-supplied release prerequisites.
