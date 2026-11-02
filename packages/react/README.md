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

```sh
pnpm add @nestvexa/react @nestvexa/inertia @nestvexa/vite @inertiajs/react react react-dom
pnpm add -D vite @vitejs/plugin-react @types/react @types/react-dom
```

Peer dependencies: `@inertiajs/react` `^3.10.0`, `react` and `react-dom`
`^19`; `@inertiajs/core` `^3.10.0` is an optional (types-only) peer. React is
never bundled into this package, so an application always has one copy.
Node `^22.13 || ^24`, ESM only.

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

## Testing

`tests/react-adapter.test.ts` (resolver, real SSR bundle, official SSR process
behind `HttpSsrGateway`, fallback/strict), `tests/browser/inertia-react.spec.ts`
plus the shared suite (SSR markup, hydration without mismatch or CSP
violations, XHR navigation, persistent nested layouts, validation, uploads,
partial reloads, deferred props, version 409, error boundary, axe) in three
browsers.

## Caveats and compatibility

- The public declarations do not reference upstream types, because
  `@inertiajs/*` 3.10.0 declarations require `moduleResolution: "bundler"`.
  Applications use upstream types directly in their components.
- No universal-action hook yet (Phase 12).
