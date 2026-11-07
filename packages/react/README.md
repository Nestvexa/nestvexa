# @nestvexa/react

React adapter for Nestvexa Inertia hosts. It boots the **official
`@inertiajs/react`** client over an explicit page registry, hydrates
server-rendered markup (or mounts when SSR fell back), wraps the app in an error
boundary, and provides the SSR entry helpers for the `@nestvexa/inertia` SSR
contract — either in-process or through the official Inertia SSR server.

Status: `0.1.0-alpha.0`, experimental. Verified with `@inertiajs/react` and
`@inertiajs/core` **3.10.0**, React **19.3.1**, Vite **8.3.5** and
`@vitejs/plugin-react` **6.1.2** in Chromium, Firefox and WebKit. See the
[React guide](../../docs/guides/react.md) and the runnable
[`examples/inertia-react`](../../examples/inertia-react).

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack`
(written to `artifacts/packages`) and install the `.tgz` files together. After
owner-authorized publication the registry syntax will be:

```sh
pnpm add @nestvexa/react @nestvexa/inertia @nestvexa/vite @inertiajs/react react react-dom
pnpm add -D vite @vitejs/plugin-react @types/react @types/react-dom
```

(`npm install` and `yarn add` take the same package names.)

Peer dependencies: `@inertiajs/react` `^3.10.0`, `react` and `react-dom`
`^19`; `@inertiajs/core` `^3.10.0` is an optional (types-only) peer. React is
never bundled into this package, so an application always has one copy.
Node `^22.13 || ^24`, ESM only.

## Architecture and dependencies

The browser half of an Inertia host: `@nestvexa/inertia` builds the page
objects on the server, `@nestvexa/vite` supplies the page registry
(`@nestvexa/vite/pages`), manifest tags and the official SSR server launcher,
and this package wires them into `@inertiajs/react`. Its only runtime
dependency is `@nestvexa/vite`. It is optional and **not** included in the
`nestvexa` umbrella. `nestvexa add react` (CLI) scaffolds a client root with
browser and SSR entries using this package (`tests/cli-generators.test.ts`).

## Usage

```ts
// client/setup.ts — shared by the browser and SSR entries
import { createPageRegistry } from '@nestvexa/react';
import type { ReactPageModule } from '@nestvexa/react';
export const pages = createPageRegistry(
  import.meta.glob<ReactPageModule>('./pages/**/*.tsx'),
  { base: './pages/', extensions: ['.tsx'] },
);

// client/app.tsx — browser entry (Vite input)
import '@vitejs/plugin-react/preamble'; // HMR in middleware mode; no-op in builds
import { mountReactInertiaApp } from '@nestvexa/react';
import { pages } from './setup';
void mountReactInertiaApp({ pages, title: (t) => `${t} · Acme` });

// client/ssr.tsx — `vite build --ssr client/ssr.tsx`
import {
  createReactSsrRender,
  isMainModule,
  startReactSsrServer,
} from '@nestvexa/react/ssr';
import { pages } from './setup';
export const render = createReactSsrRender({ pages });
if (isMainModule(import.meta.url)) startReactSsrServer(render, { port: 13716 });
```

On the Nest side use `HttpSsrGateway({ url: 'http://127.0.0.1:13716' })` (SSR
process) or `moduleSsrRenderer(join(root, 'dist/ssr/ssr.js'))` from
`@nestvexa/vite` (in-process) as `ssr.renderer`.

## Public API

`@nestvexa/react` (browser entry; also importable in Node):

| Export                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mountReactInertiaApp(options)`                                              | Calls the official `createInertiaApp` with `resolve` over `options.pages` and a `setup` that uses `hydrateRoot` when the root has `data-server-rendered`, else `createRoot`. Resolves to `{ mode: 'hydrate' \| 'mount' \| 'failed', root, error? }`. Boot errors are reported and leave SSR markup in place.                                                                                           |
| options                                                                      | `pages` (required), `id = 'app'`, `title(title, page)`, `layout(name, page)` (default persistent layout(s)), `progress` (official options or `false`), `fallback`, `onError(error, kind)` (`boot` \| `render` \| `recoverable`; React reports hydration mismatches as recoverable; default `console.error`), `strictMode`, `nonce` (default: the `<meta property="csp-nonce">` from `@nestvexa/vite`). |
| `ErrorBoundary`                                                              | Props `fallback` (node or `(error, reset) => node`), `onError`, `resetKey` (pass `usePage().url` to reset per visit). The error is never rendered. Client-only by React's design.                                                                                                                                                                                                                      |
| `DefaultErrorFallback`                                                       | Accessible `role="alert"` fallback with a reload link.                                                                                                                                                                                                                                                                                                                                                 |
| `createReactPageResolver(registry)`                                          | The resolver used internally; rejects unknown names and non-component defaults with `PageNotFoundError`.                                                                                                                                                                                                                                                                                               |
| `createPageRegistry`, `isPageName`, `PageNotFoundError`, `PageRegistryError` | Re-exported from `@nestvexa/vite/pages`.                                                                                                                                                                                                                                                                                                                                                               |
| `metaNonce()`                                                                | Reads the CSP nonce meta.                                                                                                                                                                                                                                                                                                                                                                              |
| Types                                                                        | `ReactPageModule`, `PageProps<Map, Name>` (select a page's props from a map shared with Nest controllers), `ReactInertiaAppOptions`, `ReactInertiaAppHandle`, `ReactErrorKind`, `ErrorBoundaryProps`, `ErrorFallback`, `PageGlob`, `PageRegistry`, `PageRegistryOptions`.                                                                                                                              |

`@nestvexa/react/ssr` (Node):

| Export                                                                   | Purpose                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createReactSsrRender({ pages, id?, title?, layout? })`                  | `render(page) → Promise<{ head, body }>` on the official server path (`createInertiaApp` without a page, `renderToString`). `body` is upstream `buildSSRBody` output (escaped page script + `data-server-rendered` root). Render errors and unknown components reject. |
| `startReactSsrServer(render, { port?, host?, cluster?, formatErrors? })` | Official `@inertiajs/react/server` HTTP server, loopback-only by default (port 13714).                                                                                                                                                                                 |
| `isMainModule(import.meta.url)`                                          | Run-as-entry detection.                                                                                                                                                                                                                                                |

## Security and performance

- Only registry pages can render; server-sent component names never become
  module paths. Lazy globs keep each page in its own chunk.
- Page JSON is escaped by upstream (`/` and `<`), text by React.
- React error boundaries do not run during SSR: a render error rejects the SSR
  render, and `@nestvexa/inertia` serves the client-rendered document in
  `fallback` mode (or `500` in `strict`); the client boundary then shows the
  fallback.
- Run the SSR process with `NODE_ENV=production`.

## Compatibility

- The public declarations do not reference upstream types, because
  `@inertiajs/*` 3.10.0 declarations require `moduleResolution: "bundler"`.
  Applications use upstream types directly in their components.
- Examples: [`examples/inertia-react`](../../examples/inertia-react) (including
  the `/kit` page on the `@nestvexa/ui/react` wrappers) and
  [`examples/inertia-mixed`](../../examples/inertia-mixed) (React next to Vue,
  Svelte and a Live page).

## Status and limits

Status: **Partial**. Boot, hydration, error boundary, page registry and
in-process or official-server SSR work and are tested in Chromium, Firefox and
WebKit.

- This package ships no server-action hooks. Typed React hooks
  (`createActionHooks`) come from `@nestvexa/actions` codegen with
  `--targets react`; Inertia forms use the official `useForm`/router (SPA-003).
- No framework upload hook: pages keep `@nestvexa/uploads/browser` progress in
  their own state.
- React error boundaries do not run during SSR (see above); SSR failures are
  handled by the `@nestvexa/inertia` `fallback`/`strict` mode.
- CLI-scaffolded roots render client-side in development (standalone Vite dev
  server); SSR applies to production builds.

## Testing

```sh
pnpm --filter @nestvexa/react test
```

Runs `tests/react-adapter.test.ts` (resolver, real SSR bundle, official SSR
process behind `HttpSsrGateway`, fallback/strict); the tests import
`packages/*/dist`, so run `pnpm --filter @nestvexa/react... build` first.
Browser coverage runs separately through Playwright:
`tests/browser/inertia-react.spec.ts` with the shared framework suite (SSR
markup, hydration without mismatch or CSP violations, XHR navigation,
persistent nested layouts, validation, forms and uploads, partial reloads,
deferred props, version 409, error boundary, axe),
`tests/browser/inertia-react-features.spec.ts`,
`tests/browser/inertia-react-ui-kit.spec.ts`,
`tests/browser/inertia-hmr.spec.ts` (dev-mode HMR) and
`tests/browser/inertia-mixed.spec.ts`, in three browsers.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
