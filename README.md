# Nestvexa

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

The optional [@nestvexa/live](packages/live/README.md) package implements explicit generated Nest action routes and bound server-side state; [@nestvexa/client](packages/client/README.md) implements the corresponding browser transport and a small directive subset. They are separately registered rather than implicitly activated by the MVC distribution.

The [@nestvexa/alpine](packages/alpine/README.md) adapter supplies `$live.call/get/set` to Alpine widgets inside an ignored Live subtree. The counter runs the actual Alpine CSP build with a restrictive script policy. See the [directive reference](docs/reference/directives.md) for the implemented grammar and remaining gaps.

## Safety and limitations

Ordinary `{{value}}` interpolation escapes HTML. Triple braces bypass escaping and are for framework-created layout fragments or trusted application markup only. Templates and helper functions are trusted application code. View names must come from server code. Host applications own authentication, cookies, CSRF for their routes, CSP, request limits, logging and deployment policy. Configuration flags alone do not install those controls. See [hardening](docs/security/hardening.md).

`live.enabled: true` in the MVC convenience module still fails explicitly; use `LiveModule.register` with host identity, authorization, origin and renderer contracts. This prevents insecure implicit defaults. Live state is JSON-only and stored in process memory with fixed expiry and revision locks; it is not a distributed transaction system. React, Vue, Svelte, Inertia, alternative engines, CLI and distributed transports are not implemented. The required command `npx nestvexa init` is not available yet.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:pack
pnpm test:node22
pnpm size:check
pnpm docs:build
pnpm bench
pnpm release:check
```

The release check intentionally fails while mandatory acceptance work remains. `test:pack` creates tarballs and boots a real Nest app in a temporary external consumer. Reports go under `artifacts/reports`; documentation snapshots under `artifacts/docs`. The benchmark currently measures the HBS adapter only and is not a claim of full framework performance.

See [implementation status](docs/implementation/STATUS.md), [feature ledger](docs/implementation/feature-ledger.md), [contributing](CONTRIBUTING.md), [security policy](SECURITY.md), [changelog](CHANGELOG.md) and [license](LICENSE). Registry scope ownership, maintainer identity and official project URLs remain owner-supplied release prerequisites.
