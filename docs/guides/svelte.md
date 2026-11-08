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
`tests/browser/inertia-feature-smoke.ts`). `/features/tour` covers the rest of
the client-owned features with the official Svelte client
(`defineFeatureTour` and `defineScrollAndProgress` in
`tests/browser/inertia-feature-tour.ts`): instant visits
(`component="Features/Slow"` renders before the server answers),
`router.visit`/`router.post` and a `method="post"` link, view transitions,
`useRemember` and a remembered `useForm`, `once()` props reused with
`X-Inertia-Except-Once-Props`, `optimistic` visits with rollback, scroll reset,
`preserveScroll`, back/forward restore of the window and `scroll-region`
elements, `#hash` anchors, and the progress bar (hidden with
`showProgress: false`). `pnpm start:csr` serves the same build with SSR disabled; the
client-only browser test checks the empty root mounts, navigates and
round-trips validation. `tests/vite-builds.test.ts` checks the production build
for source maps, duplicate modules/runtimes and browser-only code in the SSR
bundle.

## Typed server actions

`@nestvexa/actions` generates Svelte stores (`createActionStores`) from the server's `@ActionGroup`
classes. The example runs the codegen before its build
(`scripts/codegen.mjs`, `targets: ['svelte']`, output in the git-ignored
`client/generated/`) and `/features/actions` calls `notes.add`
(`src/actions.ts`) from an Inertia page:

```ts
// client/actions.ts
export const actionStores = createActionStores(
  createActions(createActionsClient({ csrf: xsrfToken })),
);

// client/pages/Features/Actions.svelte
const add = actionStores.notesAdd({
  initialData: untrack(() => board),
  optimistic: (current, input) => ({
    total: (current?.total ?? 0) + 1,
    latest: [input.text, ...(current?.latest ?? [])].slice(0, 5),
  }),
});
// a store: <button disabled={$add.pending} onclick={() => add.run({ text })}>
```

Input, output and the validation-issue field union come from the server
method's signature; the page props are the initial data, the optimistic value
shows while the call is pending and is rolled back when the server answers
with a validation error. The CSRF token is the session's `XSRF-TOKEN` cookie
(the one the official client echoes), sent as `x-nestvexa-csrf`
(`client/actions.ts`); identity is the host session. The browser test
(`defineTypedActionsSuite` in `tests/browser/inertia-feature-tour.ts`) checks
the request, the optimistic and rolled-back states, the server-rendered
result after a reload, and that calls without the token or from another origin
get `403`. See the [server actions guide](server-actions.md).

## UI kit components

Accessible dialog, tabs, menu, toast, date picker and data table components
for Svelte pages ship in `@nestvexa/ui/svelte`; they render the same markup as the
HBS helpers and reuse its keyboard module. See the
[UI kit guide](ui-kit.md#9-react-vue-and-svelte-pages).
