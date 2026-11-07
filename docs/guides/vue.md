# Vue with Inertia, Vite and SSR

The current official Vue adapter is **`@inertiajs/vue3`** (3.10.0, verified on
npm on 2026-11-01). `@nestvexa/vue` boots it over a page registry and provides
the SSR render function. Tested setup:
[`examples/inertia-vue`](../../examples/inertia-vue) (port 3107).

## Pages and layouts

```ts
export const pages = createPageRegistry(
  import.meta.glob<VuePageModule>('./pages/**/*.vue'),
  { base: './pages/', extensions: ['.vue'] },
);
```

Pages are single-file components using `defineProps<HomeProps>()` with the
props interfaces from `src/page-types.ts` (shared with the controllers). The
`layout` option returns `AppLayout` or `[AppLayout, UsersLayout]`; layouts use
`<slot />`. `vue-tsc -p client/tsconfig.json` type-checks components as part of
`pnpm build`.

## Entries

```ts
// client/app.ts
void mountVueInertiaApp({
  pages,
  layout,
  title,
  enhance: (app) => app.use(i18n),
});
// client/ssr.ts
export const render = createVueSsrRender({ pages, layout, title, enhance });
```

The client uses `createSSRApp` + `mount` (hydration) when the root has
`data-server-rendered`, otherwise `createApp`. The SSR side creates a fresh
`createSSRApp` per request.

## SSR choice: in-process

The Vue example imports the built bundle into the Nest process:

```ts
process.env['NODE_ENV'] ??= 'production'; // before the first render
InertiaModule.forRoot({
  ssr: {
    renderer: moduleSsrRenderer(join(root, 'dist/ssr/ssr.js'), {
      timeoutMs: 3000,
    }),
  },
});
```

No extra process or port is needed and rendering is a function call. The cost:
renders share the Nest event loop and cannot be aborted on timeout. Switch to
`startVueSsrServer(render, { port })` + `HttpSsrGateway` to isolate it.

## Errors and hydration

`ErrorBoundary` (`onErrorCaptured`) shows its `fallback` slot and resets when
`reset-key` changes. During SSR it rethrows, so a broken page falls back to
client rendering instead of shipping markup the client would not reproduce.
Enable `vue({ features: { prodHydrationMismatchDetails: true } })` in Vite to
keep mismatch details in production builds (the browser tests fail on any
console warning).

## Mixed roots

Vue can share a Nest backend with React and Svelte: give each root its own
`paths`, Vite config, `base` and manifest. Navigation inside a root is XHR;
crossing roots is a full load (see the [Inertia guide](inertia.md#multiple-roots)
and `examples/inertia-mixed`).

## Client features and client-only mode

`/features` in the example exercises client-owned Inertia features with the
official Vue client: hover prefetch reused on click, `usePoll` partial
reloads, `<WhenVisible>` over an `optional()` prop and `<InfiniteScroll>` over
a `scroll()` prop (`defineFeatureSmoke` in
`tests/browser/inertia-feature-smoke.ts`). `/features/tour` covers the rest of
the client-owned features with the official Vue client
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

`@nestvexa/actions` generates Vue composables (`createActionComposables`) from the server's `@ActionGroup`
classes. The example runs the codegen before its build
(`scripts/codegen.mjs`, `targets: ['vue']`, output in the git-ignored
`client/generated/`) and `/features/actions` calls `notes.add`
(`src/actions.ts`) from an Inertia page:

```ts
// client/actions.ts
export const actionComposables = createActionComposables(
  createActions(createActionsClient({ csrf: xsrfToken })),
);

// client/pages/Features/Actions.vue (<script setup>)
const add = actionComposables.useNotesAdd({
  initialData: props.board,
  optimistic: (current, input) => ({
    total: (current?.total ?? 0) + 1,
    latest: [input.text, ...(current?.latest ?? [])].slice(0, 5),
  }),
});
// add.state is a shallow ref, disposed with the component scope:
// <button :disabled="add.state.value.pending" @click="add.run({ text })">
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
for Vue pages ship in `@nestvexa/ui/vue`; they render the same markup as the
HBS helpers and reuse its keyboard module. See the
[UI kit guide](ui-kit.md#9-react-vue-and-svelte-pages).
