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

```sh
pnpm add @nestvexa/svelte @nestvexa/inertia @nestvexa/vite @inertiajs/svelte svelte
pnpm add -D vite @sveltejs/vite-plugin-svelte svelte-check
```

Peer dependencies: `@inertiajs/svelte` `^3.10.0`, `svelte` `^5`;
`@inertiajs/core` optional (types). Node `^22.13 || ^24`, ESM only.

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

## Testing

`tests/svelte-adapter.test.ts`, `tests/browser/inertia-svelte.spec.ts` (shared
suite, three browsers), `tests/browser/inertia-mixed.spec.ts`.

## Caveats and compatibility

- `@inertiajs/svelte` 3.10.0 `Render.svelte.d.ts` fails type-checking with
  `skipLibCheck: false` (TS2440). The example's `svelte-check` config sets
  `skipLibCheck: true`; this package types the injected `createInertiaApp`
  structurally (mirroring the 3.10.0 declaration) instead of importing it.
