# @nestvexa/vue

Vue 3 adapter for Nestvexa Inertia hosts. It boots the **official
`@inertiajs/vue3`** client (the current official Vue adapter) over an explicit
page registry, hydrates server markup with `createSSRApp` (or mounts with
`createApp` when SSR fell back), installs the Inertia plugin, wraps the app in
an error boundary, and provides SSR entry helpers for the `@nestvexa/inertia`
SSR contract.

Status: `0.1.0-alpha.0`, experimental. Verified with `@inertiajs/vue3` and
`@inertiajs/core` **3.10.0**, Vue **3.5.44**, Vite **8.3.5**,
`@vitejs/plugin-vue` **6.0.10** and `vue-tsc` **3.3.14**. See the
[Vue guide](../../docs/guides/vue.md) and
[`examples/inertia-vue`](../../examples/inertia-vue).

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack`
(written to `artifacts/packages`) and install the `.tgz` files together. After
owner-authorized publication the registry syntax will be:

```sh
pnpm add @nestvexa/vue @nestvexa/inertia @nestvexa/vite @inertiajs/vue3 vue
pnpm add -D vite @vitejs/plugin-vue vue-tsc
```

(`npm install` and `yarn add` take the same package names.)

Peer dependencies: `@inertiajs/vue3` `^3.10.0`, `vue` `^3.5`;
`@inertiajs/core` `^3.10.0` optional (types). Node `^22.13 || ^24`, ESM only.

## Architecture and dependencies

The browser half of an Inertia host: `@nestvexa/inertia` builds the page
objects on the server, `@nestvexa/vite` supplies the page registry
(`@nestvexa/vite/pages`), manifest tags and the official SSR server launcher,
and this package wires them into `@inertiajs/vue3`. Its only runtime dependency is
`@nestvexa/vite`. It is optional and **not** included in the `nestvexa`
umbrella. `nestvexa add vue` (CLI) scaffolds a client root with browser and
SSR entries using this package (`tests/cli-generators.test.ts`).

## Usage

```ts
// client/setup.ts
import { createPageRegistry } from '@nestvexa/vue';
import type { VuePageModule } from '@nestvexa/vue';
export const pages = createPageRegistry(
  import.meta.glob<VuePageModule>('./pages/**/*.vue'),
  { base: './pages/', extensions: ['.vue'] },
);

// client/app.ts
import { mountVueInertiaApp } from '@nestvexa/vue';
import { pages } from './setup';
void mountVueInertiaApp({ pages, enhance: (app) => app.use(myPlugin) });

// client/ssr.ts — `vite build --ssr client/ssr.ts`
import { createVueSsrRender } from '@nestvexa/vue/ssr';
import { pages } from './setup';
export const render = createVueSsrRender({
  pages,
  enhance: (app) => app.use(myPlugin),
});
```

Nest side: `ssr: { renderer: moduleSsrRenderer(join(root, 'dist/ssr/ssr.js')) }`
(in-process, used by the example) or `startVueSsrServer(render, { port })` in
the bundle plus `HttpSsrGateway`.

## Public API

`@nestvexa/vue`:

| Export                                                                                    | Purpose                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mountVueInertiaApp(options)`                                                             | Official `createInertiaApp` with a `setup` that picks `createSSRApp` (hydrate) when the root has `data-server-rendered`, else `createApp`; installs `plugin`, runs `enhance(app)`, mounts. Resolves `{ mode, app, error? }`.                  |
| options                                                                                   | `pages`, `id = 'app'`, `title`, `layout`, `progress`, `enhance(app)`, `onError(error, kind)` (`boot` \| `render`), `nonce` (default from the CSP meta).                                                                                       |
| `ErrorBoundary`                                                                           | `onErrorCaptured` boundary: `fallback` slot (`{ error, reset }`) or `defaultErrorFallback()`; resets when the `resetKey` string changes (pass `page.url`). During SSR it lets errors propagate so the adapter's fallback/strict mode decides. |
| `createVuePageResolver(registry)`                                                         | Resolver; rejects unknown names and empty defaults with `PageNotFoundError`.                                                                                                                                                                  |
| `createPageRegistry`, `isPageName`, `PageNotFoundError`, `PageRegistryError`, `metaNonce` | As in `@nestvexa/vite/pages`.                                                                                                                                                                                                                 |
| Types                                                                                     | `VuePageModule`, `PageProps`, `VueInertiaAppOptions`, `VueInertiaAppHandle`, `VueErrorKind`, registry types.                                                                                                                                  |

`@nestvexa/vue/ssr`: `createVueSsrRender({ pages, id?, title?, layout?, enhance? })`
(fresh `createSSRApp` per render, `vue/server-renderer` `renderToString`),
`startVueSsrServer(render, options?)` (official `@inertiajs/vue3/server`,
loopback default), `isMainModule`.

## Security and performance

- Registry-only page resolution; page JSON escaped by upstream, text by Vue.
- No state is shared between SSR requests (new app per render).
- Vue logs hydration mismatches in production builds only when
  `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__` is on; the example enables it via
  `vue({ features: { prodHydrationMismatchDetails: true } })` so tests catch
  them. Vue always logs a summary error on mismatch.
- Run hosts with `NODE_ENV=production` so the externalized Vue runtime uses its
  production build during SSR.

## Compatibility

- Public declarations avoid upstream types (bundler-only declarations upstream).
- The boundary's `resetKey` is a string.
- Examples: [`examples/inertia-vue`](../../examples/inertia-vue) and
  [`examples/inertia-mixed`](../../examples/inertia-mixed).

## Status and limits

Status: **Partial**. Boot, hydration, error boundary, page registry and SSR
(in-process or the official server) work and are tested in Chromium, Firefox
and WebKit.

- This package ships no server-action composables. Typed Vue composables
  (`createActionComposables`) come from `@nestvexa/actions` codegen with
  `--targets vue`; Inertia forms use the official `useForm`/router (SPA-003).
- No framework upload composable: pages keep `@nestvexa/uploads/browser`
  progress in their own state.
- The `@nestvexa/ui/vue` wrappers are tested but have no runnable example page
  (EXT-020).
- CLI-scaffolded roots render client-side in development (standalone Vite dev
  server); SSR applies to production builds.

## Testing

```sh
pnpm --filter @nestvexa/vue test
```

Runs `tests/vue-adapter.test.ts`; the tests import `packages/*/dist`, so run
`pnpm --filter @nestvexa/vue... build` first. Browser coverage runs separately
through Playwright: `tests/browser/inertia-vue.spec.ts` (shared framework suite
plus forms and uploads), `tests/browser/inertia-hmr.spec.ts` (dev-mode HMR) and
`tests/browser/inertia-mixed.spec.ts` (Vue next to React and Svelte roots), in
three browsers.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
