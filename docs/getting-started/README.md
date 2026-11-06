# Getting started

Nestvexa adds full-stack rendering to an ordinary NestJS application. You keep
your modules, controllers, providers, guards, pipes, interceptors and filters;
Nestvexa contributes view rendering, server-driven Live components, an Inertia
v3 server adapter, framework islands and typed server actions. Every mode is
opt-in, and several modes can run side by side in one Nest backend.

> **Status:** `0.1.0-alpha.0`, experimental. Read the
> [implementation status](../implementation/STATUS.md) before relying on any
> feature in production.

## Requirements

- Node.js 22.13+ or 24 (both LTS), ESM or CommonJS Nest projects
  (CommonJS loads the ESM packages through `require(esm)`).
- NestJS 12 (`@nestjs/common`, `@nestjs/core`) with `reflect-metadata` 0.2 and
  RxJS 7. Express is the primary tested platform; Fastify is supported where the
  individual guides say so.
- A host-owned session middleware (for example `express-session`) for Live,
  server actions, Inertia validation errors and flash data. Nestvexa never
  creates sessions or authenticates users for you.

## Choose a mode

| Mode    | Use it when                                                                        | Start here                 | Packages                                                     |
| ------- | ---------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| MVC     | You render HTML from controllers with templates, optionally with Alpine sprinkles  | [MVC](mvc.md)              | `nestvexa` (HBS), or `@nestvexa/engine-ejs`/`pug`/`nunjucks` |
| Live    | You want Livewire-style stateful components with server actions and no SPA build   | [Live components](live.md) | `nestvexa` (includes `@nestvexa/live`, client and Alpine)    |
| Inertia | Your pages are React, Vue or Svelte components driven by Nest controllers          | [Inertia](inertia.md)      | `@nestvexa/inertia`, `@nestvexa/react`/`vue`/`svelte`        |
| Hybrid  | A template page needs a few React/Vue/Svelte widgets or nested Live components     | [Hybrid pages](hybrid.md)  | `nestvexa`, `@nestvexa/islands`                              |
| API     | REST endpoints stay as they are; browser code calls typed, authorized server logic | [API and actions](api.md)  | `@nestvexa/actions` (optional)                               |

The modes compose: a single application can serve HBS pages, Live components,
Inertia roots for several frameworks and JSON APIs. Crossing between
incompatible client roots (for example from an HBS page to a React Inertia root)
is always a full page load; see the [Inertia guide](../guides/inertia.md#multiple-roots).

## Install

Install the packages from the tarballs produced by `pnpm test:pack` in this
repository, or from the npm registry once they are published there. In an
existing Nest project the commands are:

```sh
npm install nestvexa
npm install --save-dev @nestvexa/cli
npx nestvexa init --dry-run   # preview every file and patch
npx nestvexa init
```

`nestvexa init` adds `views/`, a sample Live counter and the bootstrap call, and is
idempotent. It supports Express hosts only in this version. See the
[CLI reference](../reference/cli.md) for every command and its limits. Optional
packages are installed separately (`npm install @nestvexa/inertia`, …); the
default `nestvexa` install never pulls in React, Vue, Svelte, Vite, Redis or
another template engine.

> **Known gap:** On 2026-11-05 `npm view nestvexa` returned 404 from the public
> registry, so registry installs do not work yet. Registry publication is an
> owner-authorized release step; use the packed tarballs until then.

To work from this repository instead, run `pnpm install --frozen-lockfile` and
`pnpm build`, then start any example listed in the
[root README](../../README.md#runnable-examples).

## What to read next

- Concepts: [architecture overview](../architecture/overview.md) and
  [package dependency graph](../architecture/package-dependency-graph.md).
- Live in depth: [directives](../reference/directives.md),
  [lifecycle](../guides/live-lifecycle.md), [nested components](../guides/nested-components.md),
  [effects](../guides/live-effects.md), [forms](../guides/forms.md),
  [uploads](../guides/uploads.md), [realtime](../guides/realtime.md).
- Security: [hardening](../security/hardening.md) and the
  [threat model](../security/threat-model.md).
- Coming from another stack: [plain Nest MVC](../migration/from-nest-mvc.md),
  [Livewire](../migration/from-livewire.md) or
  [Inertia with Laravel](../migration/from-inertia-laravel.md).

> **Known gap:** The CLI cannot scaffold React, Vue or Svelte projects yet
> (`make:page --renderer react` exits with code 2), and `nestvexa init` rejects
> Fastify hosts. Use the examples as templates for those setups.
