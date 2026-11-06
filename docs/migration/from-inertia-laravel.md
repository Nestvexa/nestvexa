# Coming from Inertia with Laravel

`@nestvexa/inertia` is a NestJS server adapter for the same Inertia v3 protocol
that `inertia-laravel` implements, so your React, Vue or Svelte pages and the
official client keep working. Its resolver order, error-bag shaping and status
rules were checked against the `inertia-laravel` v3.6.0 source and tests; every
golden fixture in `tests/fixtures/inertia/` names the upstream case it
reproduces. Start with [Inertia getting started](../getting-started/inertia.md).

## API mapping

| Laravel (`inertia-laravel`)                                     | Nestvexa (`@nestvexa/inertia`)                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `return Inertia::render('Users/Index', $props)`                 | `@InertiaPage('Users/Index')` on the handler and `return props`, or `return inertia('Users/Index', props)`                                                 |
| `HandleInertiaRequests` middleware                              | `InertiaModule.forRoot({...})` (global interceptor + validation filter by default)                                                                         |
| `version()` in the middleware                                   | `version: (request) => string` (for example `assets.version('react')` from `@nestvexa/vite`)                                                               |
| `share()` in the middleware                                     | `share: (request) => ({...})`; per request: `inertia.share(request, key, value)`                                                                           |
| `$rootView = 'app'` / `@inertia`, `@inertiaHead`                | `rootView: viewRootView(engine, 'inertia-root')` with `{{inertiaHead}}`, `{{inertiaBody}}`, `{{inertiaAssets}}`; or `viteInertiaRootView(assets, { app })` |
| `Inertia::optional(fn)` (formerly `lazy`)                       | `optional(() => value)`                                                                                                                                    |
| `Inertia::always($value)`                                       | `always(value)`                                                                                                                                            |
| `Inertia::defer(fn, 'group')`                                   | `defer(() => value, 'group')`; `.rescue()` reports failures in `rescuedProps`                                                                              |
| `Inertia::merge()`, `deepMerge()`, `->prepend()`, `->matchOn()` | `merge(value)`, `deepMerge(value)`, `.append(path)`, `.prepend(path)`, `.matchOn(key)`                                                                     |
| `Inertia::once(fn)` with `->as()`, `->until()`, `->fresh()`     | `once(() => value)` with `.as()`, `.until()`, `.fresh()`                                                                                                   |
| `Inertia::scroll($paginator)`                                   | `scroll(value, { ...cursor metadata })`; `<InfiniteScroll>` stays client-owned                                                                             |
| `redirect('/users')`                                            | `return redirect('/users')` (302, or 303 after PUT/PATCH/DELETE)                                                                                           |
| `back()` / `redirect()->back()`                                 | `return back({ fallback: '/' })`                                                                                                                           |
| `Inertia::location($url)`                                       | `return location(url)` (409 + `X-Inertia-Location` on Inertia requests)                                                                                    |
| `->with('success', 'Saved')` flash                              | `inertia.flash(request, 'success', 'Saved')` (needs a host session)                                                                                        |
| `ValidationException` / `$request->validate()`                  | `throw new InertiaValidationException({ field: 'message' })`, or `new ValidationPipe({ exceptionFactory: inertiaValidationExceptionFactory })`             |
| Error bags (`X-Inertia-Error-Bag`)                              | Same header and shaping; `allErrors: true` sends every message per field                                                                                   |
| `Inertia::encryptHistory()`, `Inertia::clearHistory()`          | `encryptHistory: true` option or `inertia.encryptHistory(request)`; `inertia.clearHistory(request)`                                                        |
| `->withViewData([...])`                                         | `inertia(component, props, { viewData })`                                                                                                                  |
| SSR via `php artisan inertia:start-ssr`                         | `ssr: { renderer: new HttpSsrGateway({ url }), mode: 'fallback' \| 'strict' }` plus the framework SSR entry                                                |
| CSRF through `VerifyCsrfToken` + `XSRF-TOKEN` cookie            | Host guard issuing `XSRF-TOKEN` and checking `X-XSRF-TOKEN` (pattern in the examples)                                                                      |

## Request flow in Nest

1. Your guards run first (authentication, CSRF).
2. `InertiaInterceptor` validates `X-Inertia-*` headers (`400` when malformed)
   and, on Inertia `GET` requests, answers a version mismatch with `409` and
   `X-Inertia-Location` before the handler runs. Non-GET requests never get this
   409, matching the reference adapter.
3. The handler runs with normal pipes and returns props or a result helper.
4. Shared props are merged first (page props win); `errors` is always present and
   always resolved.
5. `InertiaValidationFilter` turns validation exceptions into session-stored errors
   plus a redirect back. Responses are never `422`.

The full status-code table, prop evaluation model and parity matrix are in the
[Inertia protocol guide](../guides/inertia.md).

## Deliberate deviations

- Redirect and version-mismatch URLs are relative; the official client resolves
  them against `window.location`.
- `errors` is a reserved prop: pass errors through render options, not shared or
  page props.
- Flash data is consumed by the next rendered page instead of expiring after one
  request.
- Dotted shared keys never evaluate a lazy intermediate value; a conflict is a
  configuration error.
- Redirect targets must be single-slash relative paths or absolute URLs on
  `redirects.allowedOrigins`; anything else (including `//host`) is a `400`.

## Porting checklist

1. Keep the client pages; replace `resolvePageComponent` with
   `createPageRegistry(import.meta.glob(...))` and boot through
   `mountReactInertiaApp`, `mountVueInertiaApp` or `mountSvelteInertiaApp`.
2. Port each controller action to a Nest handler with `@InertiaPage`.
3. Move `share()` and `version()` from the middleware into `InertiaModule.forRoot`.
4. Replace Form Requests with Nest pipes or explicit checks that throw
   `InertiaValidationException`.
5. Add a session middleware (`express-session` or `@fastify/session`) and a CSRF
   guard; the adapter never creates either.
6. Build with Vite and `@nestvexa/vite` ([Vite guide](../guides/vite.md)) and run
   the framework SSR entry if you used SSR.

> **Known gap:** Precognition (`Precognition` headers, 204/422), the automatic
> "empty response → `back()`" rule, previous-URL storage, `shareOnce()` sugar,
> Inertia testing assertions (`assertInertia`) and an error-page rendering helper
> are not implemented; write a Nest exception filter that calls
> `InertiaService.render` for error pages. Several client-owned features
> (history encryption, view transitions, prefetching, polling, infinite scroll)
> are emitted by the server but not yet verified in browser tests with the
> official clients.
