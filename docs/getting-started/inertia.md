# Getting started: Inertia with React, Vue or Svelte

Inertia mode keeps routing, data loading, validation and authorization in Nest
controllers while pages are React, Vue or Svelte components rendered by the
**official** Inertia v3 clients. `@nestvexa/inertia` implements the server side
of the [Inertia protocol](https://inertiajs.com/docs/v3/core-concepts/the-protocol);
`@nestvexa/react`, `@nestvexa/vue` and `@nestvexa/svelte` boot the official
client over a page registry and provide SSR entry helpers; `@nestvexa/vite`
emits manifest tags and serves built assets.

## 1. Install

Pick one framework. Versions below are the ones the examples pin and test.

```sh
# server
npm install @nestvexa/inertia @nestvexa/vite express-session
# React
npm install @nestvexa/react @inertiajs/react react react-dom
npm install --save-dev vite @vitejs/plugin-react
# Vue
npm install @nestvexa/vue @inertiajs/vue3 vue
npm install --save-dev vite @vitejs/plugin-vue
# Svelte 5
npm install @nestvexa/svelte @inertiajs/svelte svelte
npm install --save-dev vite @sveltejs/vite-plugin-svelte
```

Tested set: `@inertiajs/*` 3.10.0, React 19.3.1, Vue 3.5.44, Svelte 5.57.3 and
Vite 8.3.5 (see [upstream compatibility](../architecture/upstream-compatibility.md)).
Frameworks are peer dependencies, so exactly one copy of each runs.

## 2. Return pages from controllers

`@InertiaPage(component)` turns the handler's return value into page props.
Validation failures throw `InertiaValidationException`; the adapter stores the
errors in the session and redirects back, which is what the official client
expects. From the [React example](../../examples/inertia-react/src/main.ts):

<!-- snippet: examples/inertia-react/src/main.ts -->

```ts
  @Get('users')
  @InertiaPage('Users/Index')
  index(): ServerProps<AppPages['Users/Index']> {
    return { users: () => users.map((user) => ({ ...user })) };
  }
```

<!-- snippet: examples/inertia-react/src/main.ts -->

```ts
  @Post('users')
  store(@Req() request: SessionRequest, @Body() body: unknown) {
    const { name, email } = validateUser(body);
    users.push({ id: users.length + 1, name, email });
    this.inertia.flash(request, 'success', `User ${name} created`);
    return redirect('/users');
  }
```

Props may be values, lazy functions or helpers: `defer()` (loaded after first
paint), `optional()` (only on partial reloads), `always()`, `merge()`/`deepMerge()`,
`once()` and `scroll()`. Their exact full-visit and partial-reload behavior is in
the [protocol guide](../guides/inertia.md#props).

## 3. Configure the module

`InertiaModule.forRoot()` sets the asset version (a mismatch answers `409` and
the client reloads), the root HTML view, shared props, a CSP nonce source and
SSR. Simplified from the example:

```ts
InertiaModule.forRoot({
  version: () => assets.version('react'),
  rootView: viteInertiaRootView(assets, { app: 'react' }),
  nonce: (request) => cspNonce(request),
  share: () => ({ appName: 'Nestvexa Inertia' }),
  ssr: { renderer: new HttpSsrGateway({ url: ssrUrl }), mode: 'fallback' },
});
```

`assets` is a `ViteAssets` instance from `@nestvexa/vite` reading the Vite
manifest. CSRF is host-owned: the example's `XsrfGuard` issues an `XSRF-TOKEN`
cookie and compares the `X-XSRF-TOKEN` header that the official client sends
([CSRF section](../guides/inertia.md#csrf)).

## 4. Boot the client

All three adapters share one shape: a `setup` module exports the page registry
(`createPageRegistry(import.meta.glob(...))`, an allowlist of components the
server may name), the layouts and a title function. Only names in the registry
can render.

### React

<!-- snippet: examples/inertia-react/client/app.tsx -->

```tsx
void mountReactInertiaApp({
  pages,
  layout,
  title,
  progress: { color: '#1d4ed8', showSpinner: false },
});
```

SSR entry: `createReactSsrRender` and `startReactSsrServer` from
`@nestvexa/react/ssr`. Guide: [React](../guides/react.md); example port 3106.

### Vue

<!-- snippet: examples/inertia-vue/client/app.ts -->

```ts
void mountVueInertiaApp({
  pages,
  layout,
  title,
  progress: { color: '#1d4ed8', showSpinner: false },
});
```

SSR entry: `createVueSsrRender` and `startVueSsrServer` from `@nestvexa/vue/ssr`.
Guide: [Vue](../guides/vue.md); example port 3107.

### Svelte

Svelte 5 uses `hydrate()`/`mount()`, so you pass the official
`createInertiaApp` in:

<!-- snippet: examples/inertia-svelte/client/app.ts -->

```ts
void mountSvelteInertiaApp({
  createInertiaApp,
  pages,
  layout,
  progress: { color: '#1d4ed8', showSpinner: false },
});
```

SSR entry: `createSvelteSsrRender` and `startOfficialSsrServer` from
`@nestvexa/svelte/ssr`. Guide: [Svelte](../guides/svelte.md); example port 3108.

## 5. Build and run

```sh
pnpm build
pnpm --filter @nestvexa/example-inertia-react start:ssr   # SSR server on 127.0.0.1:13716
pnpm --filter @nestvexa/example-inertia-react start       # http://127.0.0.1:3106
pnpm --filter @nestvexa/example-inertia-react dev         # Vite middleware + HMR
```

Without the SSR process, `mode: 'fallback'` serves the client-rendered document
and logs the failure. The [Vite guide](../guides/vite.md) covers manifests, static
serving, the dev server and SSR bundles. Browser specs:
[React](../../tests/browser/inertia-react.spec.ts),
[Vue](../../tests/browser/inertia-vue.spec.ts),
[Svelte](../../tests/browser/inertia-svelte.spec.ts) and the
[mixed host](../../tests/browser/inertia-mixed.spec.ts) running all three roots in
one Nest app.

## Several frameworks in one app

Configure `apps` with one root per framework and select a root per page with
`@InertiaPage(name, { app })` or by path prefix. Versions are namespaced per
root, so navigating between roots is always a full page load
([multiple roots](../guides/inertia.md#multiple-roots)).

> Precognition (`@Precognitive`), automatic "empty response → `back()`",
> previous-URL storage and Inertia test assertions
> (`@nestvexa/inertia/testing`) are implemented; see the
> [guide](../guides/inertia.md#empty-responses-and-the-previous-url).
> Client-owned features such as view transitions, prefetch caching, polling,
> infinite scroll, `WhenVisible`, remembered state and history encryption are
> emitted by the server but not yet verified with the official clients in
> browser tests. The CLI does not scaffold React/Vue/Svelte projects, and there
> are no React/Vue/Svelte hooks around `@nestvexa/actions` yet.
