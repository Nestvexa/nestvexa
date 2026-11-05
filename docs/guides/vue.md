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
`tests/browser/inertia-feature-smoke.ts`; the React example covers the full
tour). `pnpm start:csr` serves the same build with SSR disabled; the
client-only browser test checks the empty root mounts, navigates and
round-trips validation. `tests/vite-builds.test.ts` checks the production build
for source maps, duplicate modules/runtimes and browser-only code in the SSR
bundle.
