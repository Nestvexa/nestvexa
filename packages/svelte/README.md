# @nestvexa/svelte

Svelte 5 adapter for Nestvexa Inertia hosts. It boots the **official
`@inertiajs/svelte`** client with Svelte 5's `hydrate()` (server markup present)
or `mount()` (SSR fell back), over an explicit page registry, and provides SSR
entry helpers on `svelte/server`'s `render`.

Status: `0.1.0-alpha.0`, experimental. Verified with `@inertiajs/svelte` and
`@inertiajs/core` **3.10.0**, Svelte **5.57.3**, Vite **8.3.5**,
`@sveltejs/vite-plugin-svelte` **7.3.1** and `svelte-check` **4.7.7**. See the
[Svelte guide](../../docs/guides/svelte.md) and
[`examples/inertia-svelte`](../../examples/inertia-svelte).

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack`
(written to `artifacts/packages`) and install the `.tgz` files together. After
owner-authorized publication the registry syntax will be:

```sh
pnpm add @nestvexa/svelte @nestvexa/inertia @nestvexa/vite @inertiajs/svelte svelte
pnpm add -D vite @sveltejs/vite-plugin-svelte svelte-check
```

(`npm install` and `yarn add` take the same package names.)

Peer dependencies: `@inertiajs/svelte` `^3.10.0`, `svelte` `^5`;
`@inertiajs/core` optional (types). Node `^22.13 || ^24`, ESM only.

## Architecture and dependencies

The browser half of an Inertia host: `@nestvexa/inertia` builds the page
objects on the server, `@nestvexa/vite` supplies the page registry
(`@nestvexa/vite/pages`), manifest tags and the official SSR server launcher,
and this package wires them into `@inertiajs/svelte`. Its only runtime dependency is
`@nestvexa/vite`. It is optional and **not** included in the `nestvexa`
umbrella. `nestvexa add svelte` (CLI) scaffolds a client root with browser and
SSR entries using this package (`tests/cli-generators.test.ts`).

## Why `createInertiaApp` is passed in

`@inertiajs/svelte` 3.10.0 publishes **only the `svelte` export condition**: it
resolves inside Vite/svelte toolchains but not in plain Node. To keep this
package importable everywhere (Node tooling, tests, the packed-install check),
the application imports `createInertiaApp` (and `createServer` from
`@inertiajs/svelte/server`) and passes it in. vite-plugin-svelte bundles the
library into the SSR build automatically.

## Usage

```ts
// client/app.ts
import { createInertiaApp } from '@inertiajs/svelte';
import { mountSvelteInertiaApp } from '@nestvexa/svelte';
import { pages } from './setup'; // createPageRegistry(import.meta.glob('./pages/**/*.svelte'), ...)
void mountSvelteInertiaApp({ createInertiaApp, pages });

// client/ssr.ts — `vite build --ssr client/ssr.ts`
import { createInertiaApp } from '@inertiajs/svelte';
import createServer from '@inertiajs/svelte/server';
import {
  createSvelteSsrRender,
  isMainModule,
  startOfficialSsrServer,
} from '@nestvexa/svelte/ssr';
import { pages } from './setup';
export const render = createSvelteSsrRender({ createInertiaApp, pages });
if (isMainModule(import.meta.url))
  startOfficialSsrServer(createServer, render, { port: 13718 });
```

## Public API

`@nestvexa/svelte`:

| Export                                                                                    | Purpose                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mountSvelteInertiaApp(options)`                                                          | `hydrate(App, { target, props })` when the root has `data-server-rendered`, else `mount`. Resolves `{ mode: 'hydrate' \| 'mount' \| 'failed', error? }`; boot errors (including errors thrown while hydrating) are reported via `onError`. |
| options                                                                                   | `createInertiaApp` (required), `pages`, `id = 'app'`, `layout(name, page)`, `progress`, `onError(error)`, `nonce` (default from the CSP meta).                                                                                             |
| `createSveltePageResolver(registry)`                                                      | Resolves to the page **module** (what `@inertiajs/svelte` expects), so a `<script module>` `export const layout` keeps working.                                                                                                            |
| `createPageRegistry`, `isPageName`, `PageNotFoundError`, `PageRegistryError`, `metaNonce` | As in `@nestvexa/vite/pages`.                                                                                                                                                                                                              |
| Types                                                                                     | `SveltePageModule`, `PageProps`, `SvelteInertiaAppOptions`, `SvelteInertiaAppHandle`, `SvelteCreateInertiaApp`, registry types.                                                                                                            |

`@nestvexa/svelte/ssr`: `createSvelteSsrRender({ createInertiaApp, pages, id?, layout? })`,
`startOfficialSsrServer(createServer, render, options?)`, `isMainModule`.

## Error handling

Svelte has no component-level boundary API outside templates. Use Svelte 5's
`<svelte:boundary>` with a `failed` snippet in your layout, keyed by
`page.url` so the next visit resets it (see the example `AppLayout.svelte`).
In 5.57.3 a render error during SSR rejects the render (the boundary did not
catch it server-side in our tests), so `@nestvexa/inertia` falls back to the
client-rendered document, where the boundary shows the fallback.

## Security and performance

- Registry-only page resolution; page JSON escaped by upstream, text by Svelte.
- Svelte 5 production builds do not log hydration mismatches; they repair by
  re-rendering. The browser suite therefore asserts that the server-rendered
  `<h1>` node is adopted (same DOM node after hydration) — verified to fail on a
  deliberate structural mismatch.

## Compatibility

- `@inertiajs/svelte` 3.10.0 `Render.svelte.d.ts` fails type-checking with
  `skipLibCheck: false` (TS2440). The example's `svelte-check` config sets
  `skipLibCheck: true`; this package types the injected `createInertiaApp`
  structurally (mirroring the 3.10.0 declaration) instead of importing it.
- Examples: [`examples/inertia-svelte`](../../examples/inertia-svelte) and
  [`examples/inertia-mixed`](../../examples/inertia-mixed).

## Status and limits

Status: **Partial**. Mount, hydration, page registry and SSR (in-process or the
official server) work and are tested in Chromium, Firefox and WebKit.

- No typed server-action or state utilities wrapping `@nestvexa/actions` yet
  (SPA-003); pages use the official `useForm`/router directly.
- No adapter-level error boundary (use `<svelte:boundary>`, see above) and no
  framework upload helper.
- The `@nestvexa/ui/svelte` wrappers are tested but have no runnable example
  page (EXT-020).
- CLI-scaffolded roots render client-side in development (standalone Vite dev
  server); SSR applies to production builds.

## Testing

```sh
pnpm --filter @nestvexa/svelte test
```

Runs `tests/svelte-adapter.test.ts`; the tests import `packages/*/dist`, so run
`pnpm --filter @nestvexa/svelte... build` first. Browser coverage runs
separately through Playwright: `tests/browser/inertia-svelte.spec.ts` (shared
framework suite plus forms and uploads), `tests/browser/inertia-hmr.spec.ts`
(dev-mode HMR) and `tests/browser/inertia-mixed.spec.ts`, in three browsers.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
