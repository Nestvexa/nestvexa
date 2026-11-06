# @nestvexa/inertia

Inertia.js **v3** server adapter for NestJS. It speaks the official
[Inertia protocol](https://inertiajs.com/docs/v3/core-concepts/the-protocol) so
the official clients (`@inertiajs/react`, `@inertiajs/vue3`,
`@inertiajs/svelte`) can drive ordinary Nest controllers on Express or Fastify.
It does not ship or reimplement a client, and it has no runtime dependency on
React, Vue, Svelte or any `@inertiajs/*` package.

Status: `0.1.0-alpha.0`, experimental. Verified against Inertia docs v3 (fetched
2026-11-01), `@inertiajs/core`/`@inertiajs/react` **3.10.0** and the reference
`inertia-laravel` **v3.6.0** source. See the [protocol guide and parity
matrix](../../docs/guides/inertia.md) and [ADR 0018](../../docs/adr/0018-inertia-server-adapter.md).
Framework packages with Vite and SSR builds (`@nestvexa/react`, `vue`, `svelte`)
come in later phases.

## Install

```sh
pnpm add @nestvexa/inertia
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` `^12`, `reflect-metadata`
`^0.2.2`, `rxjs` `^7.8.2`. Node `^22.13 || ^24`. ESM only. Session-backed
features (validation errors, flash data across redirects, `clearHistory` and
`preserveFragment` across redirects) need a **host-owned** session such as
`express-session` or `@fastify/session`; the adapter never creates one.

## Minimal usage

```ts
import { Controller, Get, Module, Post, Body } from '@nestjs/common';
import {
  InertiaModule,
  InertiaPage,
  InertiaValidationException,
  defer,
  redirect,
} from '@nestvexa/inertia';

@Controller('users')
class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @InertiaPage('Users/Index', { app: 'react' })
  async index() {
    return {
      users: await this.users.list(), // regular prop
      stats: defer(() => this.users.stats()), // loaded after first paint
    };
  }

  @Post()
  async store(@Body() body: { name?: string }) {
    if (!body.name)
      throw new InertiaValidationException({ name: 'Name is required.' });
    await this.users.create(body.name);
    return redirect('/users'); // 302, or 303 after PUT/PATCH/DELETE
  }
}

@Module({
  imports: [
    InertiaModule.forRoot({
      version: process.env.ASSET_VERSION ?? '1',
      entry: { scripts: ['/build/app.js'] },
      share: (request) => ({ appName: 'Acme' }), // resolved per request
    }),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

The initial visit returns a full HTML document containing
`<script data-page="app" type="application/json">…</script><div id="app"></div>`
(the element `@inertiajs/core` 3.x reads); `X-Inertia: true` visits return the
JSON page object with `X-Inertia: true` and `Vary: X-Inertia`.

## Public API

### Module

- `InertiaModule.forRoot(options)` / `InertiaModule.forRootAsync({ imports, inject, useFactory, ...behaviour })`.
  Behaviour flags (static, also for async): `isGlobal` (default `true`),
  `interceptor: 'global' | 'decorated'` (default `global`: registers
  `InertiaInterceptor` as `APP_INTERCEPTOR` so version checks and redirect
  results work on every route), `validationFilter` (default `true`: registers
  `InertiaValidationFilter` as `APP_FILTER`).

| Option                     | Default                                                    | Meaning                                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | `''`                                                       | Asset version: string, number or `(request) => value \| Promise`.                                                                                                                                                                                               |
| `rootView`                 | `defaultRootView`                                          | `(context) => html`. Use `viewRootView(engine, view)` for HBS or another `ViewEngineAdapter`.                                                                                                                                                                   |
| `title`                    | `''`                                                       | Document title (string or `(page) => string`), HTML-escaped by the default views.                                                                                                                                                                               |
| `entry`                    | none                                                       | `{ scripts, styles }` asset URLs; scripts are `type="module"`.                                                                                                                                                                                                  |
| `id`                       | `app`                                                      | DOM id for `data-page` and the mount element.                                                                                                                                                                                                                   |
| `nonce`                    | none                                                       | `(request) => string` CSP nonce added to entry scripts.                                                                                                                                                                                                         |
| `ssr`                      | none                                                       | `{ renderer, mode: 'fallback' \| 'strict', onError }` (see SSR).                                                                                                                                                                                                |
| `apps` / `defaultApp`      | single `default` app                                       | Named roots, each with the options above plus `paths` prefixes.                                                                                                                                                                                                 |
| `share`                    | none                                                       | `(request) => props`; called for every page response, never cached.                                                                                                                                                                                             |
| `session`                  | `request.session` adapter                                  | `InertiaSessionAdapter` or `false`.                                                                                                                                                                                                                             |
| `redirects`                | `{ allowedOrigins: [], fallback: '/' }`                    | Absolute redirect allowlist and `back()` fallback.                                                                                                                                                                                                              |
| `encryptHistory`           | `false`                                                    | Global `encryptHistory: true`.                                                                                                                                                                                                                                  |
| `preserveBigIntegers`      | `false`                                                    | Encode `bigint` as `{"$bigint":"…"}` (otherwise `bigint` is rejected).                                                                                                                                                                                          |
| `allErrors`                | `false`                                                    | Send every message per field instead of the first.                                                                                                                                                                                                              |
| `exposeSharedPropKeys`     | `true`                                                     | Emit `sharedProps`.                                                                                                                                                                                                                                             |
| `limits`                   | `4096` chars, `128` entries, `256` chars/entry, depth `64` | Request header and prop nesting bounds.                                                                                                                                                                                                                         |
| `url` / `now` / `onRescue` | request path / `Date.now` / Nest logger                    | Page URL resolver, once-prop clock, rescued deferred prop observer.                                                                                                                                                                                             |
| `instrumentation`          | none                                                       | Structural tracing hook: `nestvexa.inertia.render` spans (component, response kind, page bytes, status; never props) and `nestvexa.ssr.render` per SSR render (sizes, or the closed SSR error type and fallback flag). Same shape as `@nestvexa/observability`. |
| `emptyResponse`            | `'back'`                                                   | An Inertia request whose handler returned `undefined` is redirected back (as `inertia-laravel`); `'passthrough'` keeps the empty reply.                                                                                                                         |
| `previousUrl`              | `true`                                                     | Store each `200`, non-prefetch GET page URL in the session; `back()` uses it when the `Referer` is missing or unusable.                                                                                                                                         |

### Routes and results

- `@InertiaPage(component, { app?, status?, encryptHistory?, clearHistory?, preserveBigIntegers? })`:
  the handler returns a plain props object (or any result below).
- `@UseInertia()`: applies the interceptor in `decorated` mode.
- Results (plain functions, also on `InertiaService`): `inertia(component, props, options)`,
  `redirect(url, { status?, preserveFragment? })`, `back({ fallback?, status? })`,
  `location(url)` (409 + `X-Inertia-Location` for Inertia requests, 302 otherwise).
- `InertiaService`: `render(request, response, component, props, options)` and
  `respond(request, response, result)` write through Nest's HTTP adapter (for
  `@Res()` handlers and exception filters); `share`, `flash`, `clearHistory`,
  `encryptHistory`, `storeErrors`, `version`, `appFor`, `buildPage`, `build`.
- Render options: `app`, `status`, `flash`, `errors`, `encryptHistory`,
  `clearHistory`, `preserveBigIntegers`, `viewData` (root template only).

### Props (lazy, immutable)

| Helper                      | Full visit                      | Partial reload           | Page metadata                                                |
| --------------------------- | ------------------------------- | ------------------------ | ------------------------------------------------------------ |
| value / `() => value`       | resolved (function lazily)      | only when selected       | none                                                         |
| `always(v)`                 | resolved                        | always, even if excluded | none                                                         |
| `optional(fn)`              | never resolved                  | only when selected       | none                                                         |
| `defer(fn, group?)`         | never resolved                  | only when selected       | `deferredProps[group]`; `.rescue()` → `rescuedProps`         |
| `merge(v)` / `deepMerge(v)` | resolved                        | when selected            | `mergeProps`/`prependProps`/`deepMergeProps`, `matchPropsOn` |
| `once(fn)`                  | resolved unless client holds it | always when selected     | `onceProps` (`.as()`, `.until()`, `.fresh()`)                |
| `scroll(v, { metadata })`   | resolved (or `.defer()`)        | when selected            | `scrollProps[path]` + `mergeProps`/`prependProps`            |

Modifiers return new instances, so module-level prop definitions are safe to
share between requests. `X-Inertia-Reset` removes merge labels and sets
`scrollProps[path].reset`; `X-Inertia-Infinite-Scroll-Merge-Intent: prepend`
switches scroll props to `prependProps`. Top-level dotted keys
(`'auth.user'`) are unpacked without evaluating lazy values.

### Validation, flash and errors

- `InertiaValidationException(errors, { bag?, fallback? })`; `inertiaValidationExceptionFactory`
  for `new ValidationPipe({ exceptionFactory })`; `flattenValidationErrors`.
- `InertiaValidationFilter` stores errors in the session and redirects back
  (302, 303 after PUT/PATCH/DELETE). The next page shows them once under
  `props.errors`, scoped by `X-Inertia-Error-Bag` exactly like the Laravel
  adapter. Without a session it answers 500 instead of dropping errors.
- `flash()` data is consumed by the next rendered page and survives redirects
  and version-mismatch reloads.
- `inertiaValidate(schema, input, { bag? })` validates with any
  `{ validate(input) }` schema returning `{ ok, value | errors }` (all
  `@nestvexa/forms` adapters) and throws `InertiaValidationException`; use the
  same schema with `@Precognitive`.
- `back()` resolves the same-host `Referer`, then the session's previous URL
  (`InertiaService.previousUrl(request)`), then the fallback.

### Testing helpers (`@nestvexa/inertia/testing`)

Node-only and test-runner neutral: `inertiaHeaders({ version?, partial?,
reset?, errorBag?, exceptOnceProps?, prefetch? })` builds official-client
request headers; `readInertiaPage(response, { id? })` extracts the page object
from a JSON reply or an HTML document; `assertInertia(response, component?)`
returns fluent assertions (`component`, `url`, `version`, `prop`, `has`,
`missing`, `where`, `hasErrors`, `hasNoErrors`, `flash`, `deferred`) that throw
`InertiaAssertionError`. See the
[guide](../../docs/guides/inertia.md#testing-inertia-responses).

### Precognition

`@Precognitive(validator, { input? })` makes a route answer the official
client's `Precognition: true` validation requests before pipes and the
handler run: `204` + `Precognition-Success: true` when the fields named by
`Precognition-Validate-Only` (or all fields) pass, otherwise `422`
`{ message, errors }` with message arrays. Every response of the route gets
`Vary: Precognition`. `validator` is a function `(input, request) => errors |
undefined` or any `{ validate(input) }` schema returning `{ ok, errors }`, so
`@nestvexa/forms` adapters work without a dependency on that package. Also
exported: `PrecognitionHeader`, `isPrecognitionRequest`,
`parsePrecognitionRequest`, `selectPrecognitionErrors`, and
`InertiaService.isPrecognitive()/precognition()/precognitionReply()`.
`InertiaValidationFilter` answers `InertiaValidationException` on any
precognitive request with the `422` reply. See the
[guide](../../docs/guides/inertia.md#precognition-live-validation).

### SSR contract (Phase 9 supplies renderers)

`InertiaSsrRenderer.render(page, pageJson, { request, app })` returns
`{ head: string[], body: string }`. `HttpSsrGateway({ url, timeoutMs })`
implements the documented SSR HTTP server contract (`POST /render`,
`GET /health`). In `fallback` mode (default) failures are reported to `onError`
and the client-rendered document is served; `strict` mode propagates them.
SSR is never invoked for `X-Inertia` visits.

## Security and performance notes

- Page JSON in the initial document escapes `/` (as the protocol requires), `<`,
  `>`, `&`, U+2028 and U+2029; HTML entities are never used inside the script.
- Serialization is strict: functions, symbols, non-finite numbers, invalid
  dates, Maps/Sets, Promises, cycles, own `__proto__` keys, excessive depth and
  (unless enabled) `bigint` fail with `InertiaSerializationError` (500) instead
  of degrading silently. Error messages name the path, never the value.
- Malformed `X-Inertia-*` headers (repeated/non-string, oversized, too many
  entries, prototype segments, control characters, unknown merge intent) are
  rejected with 400 before the handler runs. Only `X-Inertia: true` marks an
  Inertia request; partial headers are ignored on full page loads.
- Redirect targets must be a single-slash relative path or an allowlisted
  absolute http(s) origin. `back()` only follows a same-host `Referer` (and
  returns it as a relative path) or an allowlisted origin; otherwise it uses
  the fallback. Version-mismatch `X-Inertia-Location` is the request path,
  never derived from the `Host` header.
- `errors` is adapter-owned: shared or page props named `errors` are rejected.
- Per-request data lives in a request-keyed `WeakMap` or the host session.
  Shared props are resolved for every page response.
- CSRF is host-owned. The official client sends the `XSRF-TOKEN` cookie value
  in `X-XSRF-TOKEN`; verify it with a guard (see the guide and
  `examples/inertia-basic`).
- History encryption is performed by the official client with `crypto.subtle`
  (secure contexts: HTTPS or localhost); the server only emits
  `encryptHistory`/`clearHistory`. The React browser tour verifies the client
  stores an encrypted `ArrayBuffer` in `history.state` and refetches old
  entries after `clearHistory`. Nothing stops a user with access to the
  browser profile while the tab's session key exists.
- Precognition requests never reach the handler on `@Precognitive` routes;
  malformed `Precognition-Validate-Only` headers are a 400 and validator
  failures are a 500 without details.
- Partial reloads evaluate only requested props; deferred and optional props
  are never evaluated on a full visit (tested with call counters).

## Testing

`pnpm build`, then `pnpm vitest run tests/inertia-golden.test.ts tests/inertia-http.test.ts tests/inertia-security.test.ts tests/inertia-protocol.test.ts tests/inertia-precognition.test.ts tests/inertia-testing.test.ts`
and `pnpm exec playwright test tests/browser/inertia.spec.ts` (official
`@inertiajs/react` client against `examples/inertia-basic`); client-owned
features are verified in `tests/browser/inertia-react-features.spec.ts` and
`tests/browser/inertia-feature-smoke.ts`. Golden vectors in
`tests/fixtures/inertia/` cite the upstream document or test they come from.

## Caveats and compatibility

- Inertia protocol v3 only (clients 3.x; verified with 3.10.0). Nest 12 on
  Express and Fastify. No Inertia v1/v2 compatibility mode.
- Not implemented: `shareOnce` sugar (use `once()` in `share`) and error-page
  rendering helpers (use a Nest filter with `InertiaService.render`).
- Empty-response handling only treats a handler result of `undefined` as
  empty; handlers that inject `@Res()`/`@Next()` or declare `@HttpCode`,
  `@Redirect`, `@Render` or `@Sse` are never redirected.
- URLs in redirects and `X-Inertia-Location` are relative (upstream emits
  absolute URLs); the official client resolves both.
- Flash data is consumed by the next rendered page rather than aged by request
  count.
- Multiple roots get namespaced versions (`react:<version>`) so an XHR visit
  across roots always forces a full page load.
