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
   - both carry `Vary` (merged with an existing `Vary`): `X-Inertia` for
     documents; for JSON page responses also `X-Inertia-Version` and every
     partial-reload, reset, error-bag, merge-intent and except-once header, so a
     shared cache cannot replay a partial reload to a full visit (SEC-030).
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

## Precognition (live validation)

The official v3 clients validate fields before submission with Precognition
(`useForm('post', url, data)` + `form.validate('email')`, or the `<Form>`
component's `validate()`). The client bundles `laravel-precognition` 2.1.1 and
sends `Precognition: true` plus `Precognition-Validate-Only: name,email`
(comma-joined touched fields). The wire contract
([protocol page](https://inertiajs.com/docs/v3/core-concepts/the-protocol),
request/response headers) is:

| Outcome                    | Status | Headers                                                    | Body                                               |
| -------------------------- | ------ | ---------------------------------------------------------- | -------------------------------------------------- |
| Requested fields pass      | `204`  | `Precognition: true`, `Precognition-Success: true`, `Vary` | empty                                              |
| A requested field fails    | `422`  | `Precognition: true`, `Vary: Precognition`, JSON           | `{ "message": "…", "errors": { "field": ["…"] } }` |
| Ordinary submission        | any    | `Vary: Precognition` (merged with `X-Inertia`)             | the handler's normal response                      |
| Malformed Validate-Only    | `400`  | —                                                          | Nest error                                         |
| Validator throws (non-422) | `500`  | `Precognition: true`                                       | Nest error (no details)                            |

`@Precognitive(validator)` declares a route precognitive. For precognitive
requests the interceptor validates the input and answers before Nest pipes
and the handler run, so validation-only requests never cause side effects.
Errors are filtered by `Precognition-Validate-Only` (exact path, nested paths
below it, `*` matching one segment); a present but empty header validates no
field (Laravel's `filterPrecognitiveRules`). Errors are always sent as
message arrays; the client shows the first unless `withAllErrors` is on.

```ts
import { validateForm, zodAdapter } from '@nestvexa/forms';

const signup = zodAdapter(
  z.object({ name: z.string().min(1), email: z.email() }),
);

@Post('signup')
@Precognitive(signup) // any { validate(input) } schema, or (input, request) => errors | undefined
async register(@Body() body: unknown) {
  const result = await validateForm(signup, body); // the real submission
  if (!result.ok) throw new InertiaValidationException(result.errors);
  return redirect('/welcome');
}
```

Validators are structural: any `@nestvexa/forms` `SchemaAdapter` works
without `@nestvexa/inertia` depending on `@nestvexa/forms`, and so does a
function returning field errors. A validator may also throw
`InertiaValidationException`. The input defaults to the query for
GET/HEAD/DELETE (where the client sends it) and the parsed body otherwise;
pass `{ input: (request) => … }` to change it. `InertiaValidationFilter`
answers an `InertiaValidationException` raised during any `Precognition: true`
request with the `422` reply instead of a redirect.

Guard rejections keep the Precognition label. The official client rejects any
reply without `Precognition: true` ("Did not receive a Precognition
response"), so `InertiaModule` registers a middleware that labels every
`Precognition: true` request's response (`Precognition: true`,
`Vary: Precognition`) before guards run, and a global, never-rejecting
`PrecognitionGuard` that keeps the label on `@Precognitive` routes and removes
it on other routes. A 401/403/419/429 from a CSRF, auth or throttle guard on a
precognitive route therefore reaches `onUnauthorized`/`onForbidden` like
upstream; routes without `@Precognitive` handle `Precognition: true` requests
normally and never carry the header (as upstream without its middleware).

### Files: `validateFiles()`

By default the official client leaves files out of validation requests; after
`form.validateFiles()` it sends them as `multipart/form-data` with the same
Precognition headers. Nest route interceptors run after the Inertia
interceptor, so declare the route's body parser in `interceptors` as well:
it runs only for Precognition requests (and must call `next.handle()`), and
the default input merges multer-style `request.file`/`request.files` into
the body under their field names, so file rules see `{ title, document }`.
Ordinary submissions use the route's own interceptors.

```ts
const DocumentUpload = FileInterceptor('document', { limits: { fileSize: 1024 * 1024 } });

@Post('uploads')
@Precognitive(
  (input) => uploadErrors((input as { document?: unknown }).document),
  { interceptors: [DocumentUpload] }, // classes are created through the injector
)
@UseInterceptors(DocumentUpload)
upload(@UploadedFile() file: Express.Multer.File | undefined) { … }
```

```tsx
const form = useForm('post', '/uploads', {
  document: null as File | null,
}).validateFiles();
// onChange: form.setData('document', file); form.validate('document');
```

A parser rejection (for example multer's 413 for an oversized file) still
carries `Precognition: true`. On Fastify, register a `multipart/form-data`
content-type parser that leaves the body to the declared interceptor.

### Forms and uploads with the official useForm

`inertiaValidate(schema, input, { bag? })` runs the same structural schema as
`@Precognitive(schema)` (every `@nestvexa/forms` adapter matches) and returns
the parsed value or throws `InertiaValidationException`. Forms error bags map
to `useForm().errors` unchanged: dotted paths (`items.0.name`) stay keys and
form-level errors arrive under `_form`. For files, upload through
`@nestvexa/uploads/browser` first (progress from the upload routes), put the
returned `nvu_…` token in the form data, validate its shape precognitively,
and finalize it in the handler with `finalizeFileField`; upload failures
become field errors:

```ts
@Post('documents')
@Precognitive(documentSchema)
async store(@Req() request: object, @Body() body: unknown) {
  const value = await inertiaValidate(documentSchema, body);
  const state = documentForm.update(documentForm.create(), value);
  const files = await finalizeFileField(documentForm, state, 'attachment', (token) =>
    this.uploads.finalize(request, token, { purpose: 'documents' }),
  );
  if (!files.ok) throw new InertiaValidationException(files.errors);
  return redirect('/documents');
}
```

Runnable in `examples/inertia-{react,vue,svelte}` (`/documents`,
`src/documents.ts`), tested by `tests/browser/inertia-forms-uploads.ts`.

## Empty responses and the previous URL

As `inertia-laravel` does, an Inertia request whose handler returns nothing is
redirected back (`302`, `303` after PUT/PATCH/DELETE), so a mutation handler
needs no explicit `back()`. Only `undefined` counts as empty, plain
(non-Inertia) requests keep Nest's reply, and handlers that inject
`@Res()`/`@Next()` or declare `@HttpCode`, `@Redirect`, `@Render` or `@Sse` are
never touched. `emptyResponse: 'passthrough'` turns it off.

With a host session, every successful (`200`), non-prefetch GET page response
stores its relative URL (`previousUrl: true`, the default). `back()` and the
validation filter use the same-host `Referer` first, then that stored URL,
then the fallback; a stored value that is not a same-application relative path
is ignored. `InertiaService.previousUrl(request)` reads it.

## Testing Inertia responses

`@nestvexa/inertia/testing` (Node only, test-runner neutral) reads the page
object from an `X-Inertia` JSON reply or from the document's page script (also
the legacy `data-page` attribute) and asserts on it:

```ts
import { assertInertia, inertiaHeaders } from '@nestvexa/inertia/testing';

const response = await request(app.getHttpServer())
  .get('/users')
  .set(
    inertiaHeaders({
      version: '1',
      partial: { component: 'Users/Index', only: ['users'] },
    }),
  );
assertInertia(response, 'Users/Index')
  .has('users', 2)
  .where('users.0.name', 'Ada')
  .missing('stats')
  .hasNoErrors();
```

`prop(path)`, `has(path, length?)`, `missing`, `where(path, value | predicate)`,
`hasErrors(...fields)`, `hasNoErrors`, `flash(key, value?)`, `deferred(prop,
group?)`, `url` and `version` throw `InertiaAssertionError` with a readable
message. Responses may be supertest/light-my-request objects, `{ headers,
text }` records (with a `Headers` instance or a plain object) or a string.

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

A framework page can also host an isolated Live element; see
[coexistence](coexistence.md#a-live-element-inside-an-inertia-page).

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
`invalid-response`). It posts only to the configured URL (`http(s)`, no
credentials, query or fragment), never follows redirects and cancels a
response body beyond `maxResponseBytes` (default 5 MiB). `fallback` mode (default) logs, calls `onError` and serves
the client-rendered document; `strict` propagates a 500 without exposing the
SSR detail. Framework SSR bundles, the in-process `moduleSsrRenderer` and the
official SSR server launcher are covered in the [Vite](vite.md),
[React](react.md), [Vue](vue.md) and [Svelte](svelte.md) guides.

## Parity matrix

Legend: **Server** = implemented and tested here; **Client** = owned by the
official client (the server only needs the protocol pieces listed);
**Not implemented** = known gap.

| Feature                                                                                                                                                 | Status                                     | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial HTML with `script[data-page][type=application/json]`                                                                                            | Server                                     | golden 01, 15, 16; browser boot test                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Slash/`<`/`>`/`&`/U+2028/2029 escaping, no entities                                                                                                     | Server                                     | protocol + security tests                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| JSON page responses, `X-Inertia`, `Vary`                                                                                                                | Server                                     | golden 02                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Asset version 409 (`X-Inertia-Location`, `X-Inertia-Version`)                                                                                           | Server                                     | golden 10; browser full-reload test                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Background-request version handling (no forced reload)                                                                                                  | Client                                     | server sends the same 409; client decides                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 302→303 after PUT/PATCH/DELETE                                                                                                                          | Server                                     | golden 11, HTTP tests                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| External redirects (`location()`)                                                                                                                       | Server                                     | golden 12; allowlist enforced                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fragment redirects (`X-Inertia-Redirect`), prefetch exemption                                                                                           | Server                                     | golden 13, 14                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `preserveFragment`                                                                                                                                      | Server                                     | HTTP test                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Partial reloads (`only`/`except`, nested paths)                                                                                                         | Server                                     | golden 03; browser partial reload                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `X-Inertia-Reset`                                                                                                                                       | Server                                     | HTTP test                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Optional / always props                                                                                                                                 | Server                                     | HTTP laziness counters                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deferred props + groups, `<Deferred>` loading                                                                                                           | Server + Client                            | golden 04; browser deferred test (React/Vue/Svelte)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Rescued deferred props (`rescuedProps`)                                                                                                                 | Server                                     | golden 05                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Merge / prepend / deep merge / `matchPropsOn`                                                                                                           | Server + Client                            | golden 06, 16; `inertia-react-features` merge-prop reload                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Once props (`onceProps`, except-once, `as`, `until`, `fresh`)                                                                                           | Server + Client                            | golden 07, 08; HTTP test; `inertia-react-features` and the Vue/Svelte tour (except-once header, value reused)                                                                                                                                                                                                                                                                                                                                                               |
| Infinite scroll (`scrollProps`, merge intent, reset)                                                                                                    | Server + Client                            | golden 09; HTTP test; `<InfiniteScroll>` in `inertia-react-features` and the Vue/Svelte smoke                                                                                                                                                                                                                                                                                                                                                                               |
| Shared props, `sharedProps`, dotted keys                                                                                                                | Server                                     | HTTP tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Instant visits                                                                                                                                          | Client (verified)                          | `inertia-react-features` and the Vue/Svelte tour: component shown while the request is held                                                                                                                                                                                                                                                                                                                                                                                 |
| Flash data (`flash`, read-once)                                                                                                                         | Server                                     | HTTP + browser tests                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Validation errors, error bags, all-errors mode                                                                                                          | Server                                     | golden 17; HTTP + browser tests                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `encryptHistory` / `clearHistory`                                                                                                                       | Server (flags) / Client (crypto, verified) | golden 02, 15; `inertia-react-features`: `history.state.page` is an `ArrayBuffer`, `historyKey` dropped and entry refetched after `clearHistory`                                                                                                                                                                                                                                                                                                                            |
| Big integers (`preserveBigIntegers`, `$bigint`)                                                                                                         | Server                                     | HTTP test (opt-in; otherwise rejected)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Prefetching (`Purpose: prefetch`)                                                                                                                       | Server (header) / Client (cache, verified) | golden 14; `inertia-react-features` + Vue/Svelte smoke: hover prefetch reused on click                                                                                                                                                                                                                                                                                                                                                                                      |
| Links, manual visits, forms/`useForm`, view transitions, remembering state, polling, load-when-visible, optimistic updates, scroll management, progress | Client (verified)                          | `inertia-react-features`: `router.visit`/`router.post`, `<Link method="post">`, view transitions (when the browser has the API), `useRemember`/`useForm` remember, `usePoll`, `<WhenVisible>`, `optimistic` with rollback; the same tour on Vue and Svelte (`inertia-feature-tour.ts`); scroll reset, `preserveScroll`, back/forward restore of the window and `scroll-region` elements, `#hash` anchors and the progress bar (`showProgress: false` hides it) on all three |
| CSRF (`XSRF-TOKEN` / `X-XSRF-TOKEN`)                                                                                                                    | Host + Client                              | guard pattern tested in Vitest and the browser                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SSR HTTP gateway + graceful fallback                                                                                                                    | Server contract                            | HTTP tests; real SSR process in the React example; client-only (SSR off) browser test per adapter                                                                                                                                                                                                                                                                                                                                                                           |
| Multiple roots, path-based selection, cross-root reload                                                                                                 | Server                                     | HTTP test                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Precognition (`Precognition` headers, 204/422, guard rejections, `validateFiles()`)                                                                     | Server                                     | `@Precognitive`; golden 18-22; `tests/inertia-precognition.test.ts` (Express + Fastify, guard rejections, multipart); `inertia-react-features` with `useForm(method, url, data)`; `inertia-react` `validateFiles()` upload                                                                                                                                                                                                                                                  |
| Large page payloads (multi-MB props, SSR + XHR)                                                                                                         | Server                                     | `inertia-react-features`: 2.6 MB document and XHR page, escaping verified                                                                                                                                                                                                                                                                                                                                                                                                   |
| Automatic "empty response → back()"                                                                                                                     | Server                                     | `emptyResponse: 'back'` (default); `tests/inertia-testing.test.ts` (Express + Fastify): 302/303 back, `@Res`/`@HttpCode`/plain requests untouched, `passthrough`                                                                                                                                                                                                                                                                                                            |
| Previous-URL storage                                                                                                                                    | Server                                     | `previousUrl` (default on with a session): GET non-prefetch 200 pages stored, `back()` falls back to it; tampered values ignored; `tests/inertia-testing.test.ts`                                                                                                                                                                                                                                                                                                           |
| Inertia testing helpers                                                                                                                                 | Server                                     | `@nestvexa/inertia/testing` (`assertInertia`, `readInertiaPage`, `inertiaHeaders`); `tests/inertia-testing.test.ts`, `tests/browser/inertia-forms-uploads.ts`                                                                                                                                                                                                                                                                                                               |
| `shareOnce()` sugar                                                                                                                                     | Not implemented                            | use `once()` in `share`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Error-page rendering helper                                                                                                                             | Not implemented                            | write a Nest filter calling `InertiaService.render` (tested pattern)                                                                                                                                                                                                                                                                                                                                                                                                        |

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

## CLI

`nestvexa add react|vue|svelte` creates an independent Inertia root (Vite entry and config, scripts, a Welcome page) per framework; `nestvexa make:page <Name> --renderer react|vue|svelte` adds pages to it. See the [CLI reference](../reference/cli.md).
