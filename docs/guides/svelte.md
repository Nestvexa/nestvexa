# Svelte with Inertia, Vite and SSR

`@nestvexa/svelte` boots the official `@inertiajs/svelte` 3.10.0 client with
Svelte 5's `hydrate()`/`mount()` API (not React-style hydration) and renders on
the server with `svelte/server`'s `render`. Tested setup:
[`examples/inertia-svelte`](../../examples/inertia-svelte) (port 3108).

## Pages and layouts

```ts
export const pages = createPageRegistry(
  import.meta.glob<SveltePageModule>('./pages/**/*.svelte'),
  { base: './pages/', extensions: ['.svelte'] },
);
```

Pages use runes: `let { users }: UsersIndexProps = $props();`. Layouts receive
the page as the `children` snippet (`{@render children?.()}`). A page can also
declare `export const layout = …` in `<script module>`; the resolver returns the
module so upstream sees it. Titles use `<svelte:head><title>…</title></svelte:head>`,
which SSR returns in `head` (the Vite root view then skips its own title).

## Entries

```ts
import { createInertiaApp } from '@inertiajs/svelte';
void mountSvelteInertiaApp({ createInertiaApp, pages, layout });

// ssr.ts
export const render = createSvelteSsrRender({
  createInertiaApp,
  pages,
  layout,
});
```

`createInertiaApp` is passed in because `@inertiajs/svelte` exposes only the
`svelte` export condition (not resolvable by plain Node).
`@sveltejs/vite-plugin-svelte` bundles it into the SSR build. The example uses
in-process SSR (`moduleSsrRenderer`), like Vue; `startOfficialSsrServer(createServer,
render)` with `createServer` from `@inertiajs/svelte/server` serves it over HTTP
instead.

## Errors and hydration

Wrap layouts in `<svelte:boundary>` with a `failed` snippet and key it by
`page.url` so it resets on the next visit:

```svelte
{#key page.url}
  <svelte:boundary>
    {@render children?.()}
    {#snippet failed()}<div role="alert">Something went wrong</div>{/snippet}
  </svelte:boundary>
{/key}
```

Svelte 5.57.3 rejected the SSR render for a throwing page in our tests, so the
Nest adapter falls back to client rendering and the boundary shows the
fallback in the browser. Production Svelte does not warn about hydration
mismatches (it silently re-renders); the browser suite asserts the server `<h1>`
node is adopted by hydration and was verified to catch a deliberate mismatch.

## Type checking

`svelte-check --tsconfig client/tsconfig.json --fail-on-warnings` runs in
`pnpm build`. Because `@inertiajs/svelte` 3.10.0 ships a declaration that fails
TS2440, that tsconfig sets `skipLibCheck: true`; application `.svelte`/`.ts`
files are still checked strictly.

## Client features and client-only mode

`/features` in the example exercises client-owned Inertia features with the
official Svelte client: hover prefetch reused on click, `usePoll` partial
reloads, `<WhenVisible>` over an `optional()` prop and `<InfiniteScroll>` over
a `scroll()` prop (`defineFeatureSmoke` in
`tests/browser/inertia-feature-smoke.ts`; the React example covers the full
tour). `pnpm start:csr` serves the same build with SSR disabled; the
client-only browser test checks the empty root mounts, navigates and
round-trips validation. `tests/vite-builds.test.ts` checks the production build
for source maps, duplicate modules/runtimes and browser-only code in the SSR
bundle.
