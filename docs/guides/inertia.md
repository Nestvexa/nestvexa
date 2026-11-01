# Inertia v3 server adapter

`@nestvexa/inertia` lets the **official** Inertia clients drive ordinary Nest
controllers. This guide explains the wire contract the adapter implements, how
Nest features map onto it, and which Inertia features are server-implemented
versus owned by the client. Package reference: [README](../../packages/inertia/README.md).
Decision record: [ADR 0018](../adr/0018-inertia-server-adapter.md).

## Sources and versions

| Source                                                                                                            | Version / date                | Used for                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| [Protocol specification](https://inertiajs.com/docs/v3/core-concepts/the-protocol) and v3 data/security/SSR pages | fetched 2026-11-01            | Headers, page object, status rules, prop evaluation model, SSR wire contract |
| `@inertiajs/core`, `@inertiajs/react` (npm)                                                                       | 3.10.0 (published 2026-10-30) | Initial page lookup, request headers, 409 handling, `$bigint` parsing        |
| `inertia-laravel` (reference adapter) source and tests                                                            | tag v3.6.0                    | Exact resolver/metadata order, error-bag shaping, golden test vectors        |

Every golden fixture under `tests/fixtures/inertia/` names the document section
or upstream test it reproduces, and lists any intentional delta.

## Request lifecycle in Nest

1. Guards run first (authentication, CSRF). A guard rejection is a normal Nest
   error response, which the client treats as an exception.
2. `InertiaInterceptor` validates the `X-Inertia-*` headers (400 when
   malformed) and, for `X-Inertia: true` **GET** requests, compares
   `X-Inertia-Version` with the route's root version. A mismatch answers
   `409` with `X-Inertia-Location: <request path>` and `X-Inertia-Version:
<current>` before the handler runs. Non-GET requests never get this 409.
3. The handler runs with normal pipes. It returns props (`@InertiaPage`) or a
   result (`inertia()`, `redirect()`, `back()`, `location()`).
4. The adapter resolves shared and page props lazily (see below), serializes the
   page object strictly and replies:
   - full visit: `text/html` document with
     `<script data-page="<id>" type="application/json">…</script><div id="<id>"></div>`;
   - Inertia visit: `application/json` page object, `X-Inertia: true`;
   - both carry `Vary: X-Inertia` (merged with an existing `Vary`).
5. Exception filters run as usual. `InertiaValidationFilter` turns
   `InertiaValidationException` into errors-in-session plus a redirect back.

## Status codes and redirects

| Situation                                        | Response                                               |
| ------------------------------------------------ | ------------------------------------------------------ |
| Page                                             | `200` (or the `status` option, 2xx/4xx/5xx)            |
| `redirect()` after GET/POST                      | `302 Location`                                         |
| `redirect()` / `back()` after PUT, PATCH, DELETE | `303 Location`                                         |
| explicit `status` 301/307/308                    | kept as given                                          |
| Inertia request, redirect target with `#`        | `409 X-Inertia-Redirect` (not for `Purpose: prefetch`) |
| `location(url)`, Inertia request                 | `409 X-Inertia-Location` (no `X-Inertia` header)       |
| `location(url)`, full visit                      | `302 Location`                                         |
| version mismatch, Inertia GET                    | `409 X-Inertia-Location` + `X-Inertia-Version`         |

Redirect targets must be single-slash relative paths or absolute http(s) URLs on
an allowlisted origin (`redirects.allowedOrigins`). Everything else, including
`//host`, `/\host`, `javascript:` and CR/LF, is rejected with 400.

## Props

Resolution follows the protocol's "Prop Evaluation Model" table and the
reference resolver, including nested dot paths (`only: ['auth.user']`), the
rule that children of a lazily produced value bypass partial filtering, and the
unwrap-once rule for factories that return a prop type. Shared props are merged
first (page props win), `errors` is always first and always resolved.

| Category                      | Full visit                                                          | Partial reload (`X-Inertia-Partial-Component` matches)             |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| plain value / function        | resolved                                                            | only when matched by `only`/not `except`                           |
| `always()` (and `errors`)     | resolved                                                            | always                                                             |
| `optional()`                  | skipped, not announced                                              | when selected                                                      |
| `defer(fn, group)`            | skipped, listed in `deferredProps`                                  | when selected; `.rescue()` failures → `rescuedProps`               |
| `merge`/`deepMerge`/`prepend` | resolved, labelled                                                  | labelled when included; reset paths are unlabelled                 |
| `once()`                      | resolved unless in `X-Inertia-Except-Once-Props` (Inertia requests) | always when selected; except-once ignored                          |
| `scroll()`                    | resolved, `scrollProps` + merge label                               | merge intent header picks append/prepend; reset sets `reset: true` |

Partial headers are honoured only on `X-Inertia: true` requests; a full page
load always receives every eligible prop.

## Validation, errors and flash

`errors` is shaped exactly like `Middleware::resolveValidationErrors` in the
reference adapter: with errors in the `default` bag and an
`X-Inertia-Error-Bag: createUser` header the page receives
`errors.createUser.<field>`; with only the default bag it receives
`errors.<field>`; with only named bags it receives all bags. The first message
per field is sent unless `allErrors: true`. Errors and flash data are stored in
the host session and consumed by the next rendered page. Validation responses
are redirects (never 422) because Inertia detects errors from `props.errors`.

```ts
app.useGlobalPipes(
  new ValidationPipe({ exceptionFactory: inertiaValidationExceptionFactory }),
);
```

## Multiple roots

```ts
InertiaModule.forRoot({
  apps: {
    react: {
      id: 'app',
      version: reactManifestHash,
      entry: { scripts: ['/react/app.js'] },
    },
    vue: {
      id: 'app',
      version: vueManifestHash,
      paths: ['/vue'],
      entry: { scripts: ['/vue/app.js'] },
    },
  },
  defaultApp: 'react',
});
```

The root is chosen by `@InertiaPage(..., { app })`, then the longest matching
path prefix, then `defaultApp`. With more than one root, versions are
namespaced (`react:<hash>`), so an Inertia visit from one root to another
always receives a version 409 and performs a full page load. Same-root
navigation stays an XHR visit.

## HTML root templates

`defaultRootView` produces a minimal HTML5 document. To use Handlebars:

```ts
const engine = new HbsEngine({ root: viewsDir });
InertiaModule.forRoot({ rootView: viewRootView(engine, 'inertia-root') });
```

```hbs
<html><head><title
    >{{inertiaTitle}}</title>{{inertiaAssets}}{{inertiaHead}}</head>
  <body>{{inertiaBody}}</body></html>
```

`inertiaHead`, `inertiaBody` and `inertiaAssets` are trusted `SafeHtml` built by
the adapter; never place request data into them yourself.

## CSRF

The official client reads the `XSRF-TOKEN` cookie and sends it as
`X-XSRF-TOKEN` on every request (names configurable on the client). Nestvexa
does not own sessions or CSRF; register a guard that issues a per-session random
token in a readable `XSRF-TOKEN` cookie on safe requests and compares
`X-XSRF-TOKEN` with `timingSafeEqual` on unsafe ones. A working guard is in
[`examples/inertia-basic`](../../examples/inertia-basic/src/main.ts) and is
exercised by `tests/inertia-security.test.ts` and the browser spec (forged and
cross-session tokens are rejected with 403).

## SSR contract

`ssr.renderer` implements `render(page, pageJson, { request, app })` and returns
`{ head, body }`. `HttpSsrGateway` talks to the official Inertia SSR server
(`POST /render`, `GET /health`) and classifies failures (`browser-api`,
`component-resolution`, `render`, `connection`, `timeout`,
`invalid-response`). `fallback` mode (default) logs, calls `onError` and serves
the client-rendered document; `strict` propagates a 500 without exposing the
SSR detail. Running the SSR process and framework bundles is Phase 9.

## Parity matrix

Legend: **Server** = implemented and tested here; **Client** = owned by the
official client (the server only needs the protocol pieces listed);
**Not implemented** = known gap.

| Feature                                                                                                                                                 | Status                           | Evidence / notes                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| Initial HTML with `script[data-page][type=application/json]`                                                                                            | Server                           | golden 01, 15, 16; browser boot test                                 |
| Slash/`<`/`>`/`&`/U+2028/2029 escaping, no entities                                                                                                     | Server                           | protocol + security tests                                            |
| JSON page responses, `X-Inertia`, `Vary`                                                                                                                | Server                           | golden 02                                                            |
| Asset version 409 (`X-Inertia-Location`, `X-Inertia-Version`)                                                                                           | Server                           | golden 10; browser full-reload test                                  |
| Background-request version handling (no forced reload)                                                                                                  | Client                           | server sends the same 409; client decides                            |
| 302→303 after PUT/PATCH/DELETE                                                                                                                          | Server                           | golden 11, HTTP tests                                                |
| External redirects (`location()`)                                                                                                                       | Server                           | golden 12; allowlist enforced                                        |
| Fragment redirects (`X-Inertia-Redirect`), prefetch exemption                                                                                           | Server                           | golden 13, 14                                                        |
| `preserveFragment`                                                                                                                                      | Server                           | HTTP test                                                            |
| Partial reloads (`only`/`except`, nested paths)                                                                                                         | Server                           | golden 03; browser partial reload                                    |
| `X-Inertia-Reset`                                                                                                                                       | Server                           | HTTP test                                                            |
| Optional / always props                                                                                                                                 | Server                           | HTTP laziness counters                                               |
| Deferred props + groups, `<Deferred>` loading                                                                                                           | Server + Client                  | golden 04; browser deferred test                                     |
| Rescued deferred props (`rescuedProps`)                                                                                                                 | Server                           | golden 05                                                            |
| Merge / prepend / deep merge / `matchPropsOn`                                                                                                           | Server                           | golden 06, 16                                                        |
| Once props (`onceProps`, except-once, `as`, `until`, `fresh`)                                                                                           | Server                           | golden 07, 08; HTTP test                                             |
| Infinite scroll (`scrollProps`, merge intent, reset)                                                                                                    | Server                           | golden 09; HTTP test. `<InfiniteScroll>` is client-owned             |
| Shared props, `sharedProps`, dotted keys                                                                                                                | Server                           | HTTP tests                                                           |
| Instant visits                                                                                                                                          | Client                           | relies on `sharedProps` (emitted)                                    |
| Flash data (`flash`, read-once)                                                                                                                         | Server                           | HTTP + browser tests                                                 |
| Validation errors, error bags, all-errors mode                                                                                                          | Server                           | golden 17; HTTP + browser tests                                      |
| `encryptHistory` / `clearHistory`                                                                                                                       | Server (flags) / Client (crypto) | golden 02, 15                                                        |
| Big integers (`preserveBigIntegers`, `$bigint`)                                                                                                         | Server                           | HTTP test (opt-in; otherwise rejected)                               |
| Prefetching (`Purpose: prefetch`)                                                                                                                       | Server (header) / Client (cache) | golden 14                                                            |
| Links, manual visits, forms/`useForm`, view transitions, remembering state, polling, load-when-visible, optimistic updates, scroll management, progress | Client                           | standard requests; links/forms/history exercised in the browser spec |
| CSRF (`XSRF-TOKEN` / `X-XSRF-TOKEN`)                                                                                                                    | Host + Client                    | guard pattern tested in Vitest and the browser                       |
| SSR HTTP gateway + graceful fallback                                                                                                                    | Server contract                  | HTTP tests with a contract fake; real SSR process is Phase 9         |
| Multiple roots, path-based selection, cross-root reload                                                                                                 | Server                           | HTTP test                                                            |
| Precognition (`Precognition` headers, 204/422)                                                                                                          | Not implemented                  | tracked for the forms phase                                          |
| Automatic "empty response → back()"                                                                                                                     | Not implemented                  | return `back()` explicitly                                           |
| Previous-URL storage, `shareOnce()` sugar, Inertia testing helpers                                                                                      | Not implemented                  | use `once()` in `share`; HTTP tests instead of assert helpers        |
| Error-page rendering helper                                                                                                                             | Not implemented                  | write a Nest filter calling `InertiaService.render` (tested pattern) |

## Known deviations from the reference adapter

- Redirect and version-mismatch URLs are relative; the official client resolves
  them against `window.location` (verified in the browser test).
- `errors` cannot be overridden by shared or page props (reserved key); pass
  `errors` in render options instead.
- Flash data is consumed by the next rendered page instead of expiring after
  one request.
- Dotted shared keys never evaluate a lazy intermediate value; a conflict is a
  configuration error.
- A deferred scroll prop is labelled `<path>.<wrapper>` on the full visit (the
  reference adapter labels the root path there; full visits ignore labels).
