# @nestvexa/observability

Tracing, metrics and redacted structured logging for Nestvexa Live, with an
OpenTelemetry bridge, a development-only devtools panel and a development error page with clickable source locations. Optional; no runtime
dependencies and no vendor lock-in.

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack`
(written to `artifacts/packages`) and install the `.tgz` file. After
owner-authorized publication the registry syntax will be:

```sh
npm install @nestvexa/observability
pnpm add @nestvexa/observability
yarn add @nestvexa/observability
```

Peers: `@nestjs/common`/`@nestjs/core` 12, `reflect-metadata` 0.2, `rxjs` 7.8
(used by the devtools module and the error filter). Node 22.13+ or 24, ESM only.
It is not part of the `nestvexa` umbrella and no Nestvexa package depends on it:
Live, actions, uploads, Inertia, realtime and Vite accept its `instrumentation`
shape structurally, and an OpenTelemetry `Tracer` is passed in, not imported.

## Live spans

Pass an `instrumentation` to the Live policy (`LiveModule.register`, `registerAsync`
or the umbrella `useFactory` result):

```ts
import { trace } from '@opentelemetry/api';
import {
  MemoryInstrumentation,
  combineInstrumentation,
  openTelemetryInstrumentation,
} from '@nestvexa/observability';

const devtools = new MemoryInstrumentation();
const instrumentation = combineInstrumentation(
  openTelemetryInstrumentation(trace.getTracer('nestvexa')),
  devtools,
);
// useFactory: () => ({ origin, resolveIdentity, authorize, instrumentation })
```

| Span                    | Attributes                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `nestvexa.live.mount`   | `nestvexa.component`                                                                                                      |
| `nestvexa.live.admit`   | `nestvexa.component`, `nestvexa.action` (request admission: origin, CSRF, rate limit and authorization)                   |
| `nestvexa.live.hydrate` | `nestvexa.component`, `nestvexa.revision`, `nestvexa.state_fields`                                                        |
| `nestvexa.live.hook`    | `nestvexa.component`, `nestvexa.hook` (only hooks the component defines)                                                  |
| `nestvexa.live.action`  | `nestvexa.component`, `nestvexa.action`, `nestvexa.revision`, `nestvexa.response_html_bytes` (the HTML the client morphs) |
| `nestvexa.live.render`  | `nestvexa.component`, `nestvexa.depth`, `nestvexa.html_bytes`, `nestvexa.state_bytes`                                     |

Failed spans carry `status` and, for protocol rejections, the closed
`nestvexa.error_code` (`ORIGIN_REJECTED`, `CSRF_REJECTED`, `RATE_LIMIT`,
`ACTION_FORBIDDEN`, ...).

Public state, identity bindings, CSRF/snapshot tokens, HTML and exception messages
are never attached. Outcomes are `ok`/`error` (OpenTelemetry status OK/ERROR).
A throwing instrumentation hook never breaks a request. Browser timings remain
available through the client `onDiagnostic` option.

### Other packages (structural hooks)

`@nestvexa/actions`, `@nestvexa/uploads`, `@nestvexa/inertia`, `@nestvexa/realtime` and `@nestvexa/vite` accept the same
`instrumentation` shape in their module options without importing this package:

| Span                           | Package / option                              | Attributes                                                                                                                      |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `nestvexa.action`              | `ActionsModule.register({ instrumentation })` | `nestvexa.action_group`, `nestvexa.action`, `nestvexa.error_code` on failures                                                   |
| `nestvexa.upload.receive`      | `UploadsModule.register({ instrumentation })` | `nestvexa.upload.mode` (`direct`/`chunked`/`form`), `.purpose`, `.bytes`, `.files`                                              |
| `nestvexa.upload.finalize`     | same                                          | `nestvexa.upload.purpose`, `.bytes`, `.scan`                                                                                    |
| `nestvexa.inertia.render`      | `InertiaModule.forRoot({ instrumentation })`  | `nestvexa.page`, `nestvexa.inertia.kind` (`json`/`document`), `nestvexa.page_bytes`, `status`                                   |
| `nestvexa.ssr.render`          | same (every SSR renderer)                     | `nestvexa.page`, `nestvexa.inertia.app`, `.ssr.head_elements`, `.ssr.body_bytes`; on failure `.ssr.error_type`, `.ssr.fallback` |
| `nestvexa.realtime.publish`    | `RealtimeModule.forRoot({ instrumentation })` | `nestvexa.realtime.channel_kind` (channel name up to the first `:`), `.payload_bytes`                                           |
| `nestvexa.realtime.subscribe`  | same                                          | `.transport` (`sse`/`poll`/`websocket`), `.tokens`, `.channels`; `status`, `nestvexa.error_code` on rejection                   |
| `nestvexa.realtime.connection` | same                                          | `.transport`, `.channels`, `.close_reason` (the duration is the connection lifetime)                                            |
| `nestvexa.realtime.deliver`    | same                                          | `.channel_kind`, `.backpressure`                                                                                                |
| `nestvexa.asset.serve`         | `viteStaticMiddleware({ instrumentation })`   | `nestvexa.asset.method`, `.hit`, `.type`, `.bytes`, `.immutable`, `status`                                                      |
| `nestvexa.job.run`             | `new JobRunner({ instrumentation })`          | `nestvexa.job`, `nestvexa.job.attempt`                                                                                          |
| `nestvexa.request`             | `requestTracingMiddleware(instrumentation)`   | `nestvexa.http.method`, `.status`, `.response_bytes`, `.aborted`; every span gets `requestId`                                   |
| `nestvexa.guard`               | `traceGuard(guard, instrumentation)`          | `nestvexa.guard` (class name), `.context`, `.allowed`, `status` on exceptions                                                   |

Inputs, results, props, file names, tokens and identities are never attached.

## Render budget (development only)

```ts
const instrumentation = renderBudgetInstrumentation({
  inner: combineInstrumentation(otel, devtools), // optional
  slowRenderMs: 50, // nestvexa.live.render / nestvexa.inertia.render
  slowActionMs: 250, // nestvexa.live.action / nestvexa.action
  maxHtmlBytes: 102_400,
  maxStateBytes: 32_768,
  maxPageBytes: 262_144, // Inertia page object
  maxRendersPerWindow: 25, // root renders of one component per loopWindowMs
  loopWindowMs: 1000,
});
```

Warnings (`slow-render`, `slow-action`, `large-html`, `large-state`,
`large-page`, `render-loop`) go to `onWarning` or, by default,
`process.emitWarning` with code `NESTVEXA_RENDER_BUDGET`. Identical warnings are
suppressed for `repeatAfterMs` (10 s). With `environment` (default `NODE_ENV`)
equal to `production` the function returns `inner` unchanged. Loop detection
counts root renders only, so a page rendering many child instances is not a
loop. Not covered: N+1 queries (no database integration) and island bundle
sizes (use the build's size report).

## Trace context (W3C `traceparent`)

```ts
import { trace, context } from '@opentelemetry/api';
app.use(traceContextMiddleware({ trust: (request) => isInternal(request) }));
const otel = openTelemetryInstrumentation(trace.getTracer('nestvexa'), {
  api: { trace, context },
});
```

`traceContextMiddleware` validates an inbound `traceparent` (strict W3C grammar,
lowercase hex, no all-zero ids, no duplicates, bounded length) and keeps it in
`AsyncLocalStorage` for the request. Spans started by the bridge are then
parented on it unless an active span already exists (for example from
`@opentelemetry/instrumentation-http`, which wins). `tracestate` is dropped
unless `keepTraceState: true`. `MemoryInstrumentation` records the inbound
`traceId` for devtools correlation. `parseTraceparent`, `parseTraceState`,
`formatTraceparent`, `readTraceContext`, `currentTraceContext` and
`runWithTraceContext` are exported for custom transports and jobs.

The browser side is **server-side only by design**: `@nestvexa/client` does
not generate `traceparent` (the 48 KiB client budget is reserved for the
runtime). A browser OpenTelemetry SDK with fetch/XHR instrumentation sends it
on same-origin requests, and this middleware accepts it. Remote parents are
untrusted: use `trust` or a sampler that does not blindly honor a client's
sampled flag.

## API

| Export                                                                                     | Purpose                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `openTelemetryInstrumentation(tracer)`                                                     | Bridge to any OpenTelemetry-shaped `Tracer` (structural; no dependency)                                                         |
| `MemoryInstrumentation(capacity?, now?)`                                                   | Bounded recorder with `records` and `summary()` (count, errors, p50, p95, max)                                                  |
| `combineInstrumentation(...targets)`                                                       | Fan out spans                                                                                                                   |
| `redact(value)` / `createLogger(sink?)`                                                    | Redacted JSON-lines logging (passwords, tokens, cookies, sessions, CSRF, snapshots, bindings, API keys)                         |
| `DevtoolsModule.register({ instrumentation, inspector?, authorize, path?, environment? })` | Development panel, `data.json` and `spans.json` at `/_nestvexa/devtools`                                                        |
| `DevtoolsInspector(options?)`                                                              | Live `inspector` hook: component catalog and redacted public state of recent renders                                            |
| `devtoolsSnapshot(instrumentation, inspector?)` / `DEVTOOLS_SCHEMA`                        | The versioned `data.json` contract (`nestvexa-devtools/1`, [ADR 0034](../../docs/adr/0034-devtools-browser-extension-scope.md)) |
| `requestTracingMiddleware(instrumentation?, { trustRequestId?, responseHeader? })`         | Request ids (`X-Request-Id`, `currentRequestId()`) and `nestvexa.request` spans                                                 |
| `traceGuard(guard, instrumentation, name?)`                                                | Wrap a host guard as `nestvexa.guard` spans                                                                                     |

## Development panel

```ts
import {
  DevtoolsInspector,
  DevtoolsModule,
  MemoryInstrumentation,
  requestTracingMiddleware,
} from '@nestvexa/observability';

const development = process.env['NODE_ENV'] !== 'production';
export const devtools = new MemoryInstrumentation();
export const inspector = development ? new DevtoolsInspector() : undefined;
// Live policy: useFactory: () => ({ ..., instrumentation: devtools, inspector })
// Root module imports, development only:
//   DevtoolsModule.register({ instrumentation: devtools, inspector, authorize: isDeveloper })
// main.ts: app.use(requestTracingMiddleware(devtools));
```

`/_nestvexa/devtools` then shows:

- **Registered components**: name, view, actions, state fields (writable
  marked), lazy loading and realtime refresh.
- **Components on recent pages**: each top-level mount, action and model sync
  with its re-render cause (`mount`, `action save`, `model sync of email`),
  revision, state and HTML sizes, request id, form validation errors (a
  non-empty `errors` state field) and the public state with sensitive keys
  redacted (`redact()` rules; at most 8 KiB per render).
- **Actions** (Live and server actions) with timings, outcome and the size of
  the HTML the client morphs; **errors** with status and closed error code, so
  CSRF, origin, rate-limit and authorization rejections are visible;
  **requests** with their ids; **lifecycle hooks**; **realtime**
  subscriptions, connections, publishes and deliveries; **background jobs**;
  **renderer** counts (Live, Inertia document/JSON, SSR); span timings and
  recent spans.

The same data is served as `data.json` with `schema: "nestvexa-devtools/1"`,
the stable contract recorded in [ADR 0034](../../docs/adr/0034-devtools-browser-extension-scope.md) (which also records the
browser extension as out of scope for v1). Not shown: browser-side morph
timing and network batching (use the browser's developer tools and the client
`onDiagnostic` option), cache hit/miss and prop resolution (no hook yet).

## Devtools safety

`DevtoolsModule.register` and `new DevtoolsInspector()` throw when the
environment is `production`; without an explicit `environment`, requests answer
404 once `NODE_ENV` is `production`. Every resource (page, stylesheet,
`data.json`, `spans.json`) requires the host `authorize(request)` check. The
page is server-rendered, runs no script, escapes every value and is served
`no-store` with `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src data:;
base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Live never passes
identities, tokens, snapshots or HTML to the inspector, and sensitive state
keys are redacted.

## Development error page

```ts
import { DevErrorFilter } from '@nestvexa/observability';

if (process.env['NODE_ENV'] !== 'production')
  app.useGlobalFilters(
    new DevErrorFilter(app.getHttpAdapter(), {
      viewsRoot: resolve('views'), // the Nestvexa views.root
      projectRoot: process.cwd(),
      editor: 'vscode', // 'cursor' | 'idea' | 'file'
    }),
  );
```

`nestvexa add devtools` generates exactly this guard. Server errors on requests
that accept `text/html` render a page with the message, the cause chain, the
failing **template location** (`views/pages/home.hbs:3`) with a five-line excerpt
and **clickable links** (`vscode://file/<path>:<line>:<column>`) for the template
and for application stack frames (frames in `node_modules` and Node internals stay
plain text). Locations come from the engines' own reports: Handlebars parse
errors, and EJS/Pug/Nunjucks errors in debug mode (`debug` defaults to
`!cache`); Handlebars runtime errors such as a missing helper link the file
without a line.

| Export                                 | Purpose                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `DevErrorFilter(httpAdapter, options)` | Catch-all filter; HTTP exceptions and non-HTML requests keep Nest's default response |
| `describeError(error, options)`        | Structured report (`template`, `frames`, `causes`)                                   |
| `renderDevErrorPage(report)`           | Escaped HTML page                                                                    |
| `templateFailure(error)`               | `{ view, line?, column? }` extracted from an engine error                            |

Safety: construction throws when the environment is `production`; only files that
resolve inside `viewsRoot` (real paths, symlink escapes refused, at most 1 MiB)
are read for excerpts; every value is HTML-escaped; responses are `no-store` with
`default-src 'none'`. `nestvexa doctor --production` fails when `DevErrorFilter`
or `DevtoolsModule` is registered in a file without a `NODE_ENV` guard.

## Status and limits

Status: **Partial**. Live and cross-package spans, the OpenTelemetry bridge,
trace context, request ids, render budgets, redacted logging, the devtools panel
and the development error page work and are tested; the panel still lacks named
DX-033 views.

- The panel does not show browser-side morph timing or network batches (use the
  client `onDiagnostic` option and browser developer tools), cache hit/miss,
  prop resolution, nested child renders, a live subscription gauge or MVC-only
  renderer counts (DX-033).
- `@nestvexa/client` does not send `traceparent`; client-side spans need a
  browser OpenTelemetry SDK (DX-035, by design).
- A devtools browser extension is out of scope for v1
  ([ADR 0034](../../docs/adr/0034-devtools-browser-extension-scope.md)).
- Render budgets do not detect N+1 queries or island bundle sizes.
- `MemoryInstrumentation` keeps the last `capacity` (default 500) records in process memory; export
  production telemetry through the OpenTelemetry bridge.

## Testing

```sh
pnpm --filter @nestvexa/observability test
```

Runs `tests/observability*.test.ts` and `tests/devtools-*.test.ts` with the root
Vitest config (`devtools-browser` drives Chromium, plus Firefox and WebKit with
`NV_UI_BROWSERS`); the tests import `packages/*/dist` of Live, the HBS engine,
actions, uploads, Inertia, realtime and Vite, so run `pnpm build` first. The
development error page suite runs separately:
`pnpm exec vitest run tests/dev-errors.test.ts`.

See the [observability guide](../../docs/guides/observability.md). License: MIT.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
