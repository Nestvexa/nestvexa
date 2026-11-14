# Observability

Tracing, metrics and redacted structured logging for Nestvexa Live, with an
OpenTelemetry bridge, a development-only devtools panel and a development error page with clickable source locations. Optional; no runtime
dependencies and no vendor lock-in.

## Install

```sh
npm install @nestvexa/observability
```

Peers for the devtools module: `@nestjs/common`/`@nestjs/core` 12. Node 22.13+ or 24.

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

## API

| Export                                                                                     | Purpose                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `openTelemetryInstrumentation(tracer)`                                                     | Bridge to any OpenTelemetry-shaped `Tracer` (structural; no dependency)                                                 |
| `MemoryInstrumentation(capacity?, now?)`                                                   | Bounded recorder with `records` and `summary()` (count, errors, p50, p95, max)                                          |
| `combineInstrumentation(...targets)`                                                       | Fan out spans                                                                                                           |
| `redact(value)` / `createLogger(sink?)`                                                    | Redacted JSON-lines logging (passwords, tokens, cookies, sessions, CSRF, snapshots, bindings, API keys)                 |
| `DevtoolsModule.register({ instrumentation, inspector?, authorize, path?, environment? })` | Development panel, `data.json` and `spans.json` at `/_nestvexa/devtools`                                                |
| `DevtoolsInspector(options?)`                                                              | Live `inspector` hook: component catalog and redacted public state of recent renders                                    |
| `devtoolsSnapshot(instrumentation, inspector?)` / `DEVTOOLS_SCHEMA`                        | The versioned `data.json` contract (`nestvexa-devtools/1`, [ADR 0034](../adr/0034-devtools-browser-extension-scope.md)) |
| `requestTracingMiddleware(instrumentation?, { trustRequestId?, responseHeader? })`         | Request ids (`X-Request-Id`, `currentRequestId()`) and `nestvexa.request` spans                                         |
| `traceGuard(guard, instrumentation, name?)`                                                | Wrap a host guard as `nestvexa.guard` spans                                                                             |

## Render budgets, trace context and other packages

- Wrap your instrumentation with `renderBudgetInstrumentation({ inner })` to
  get development-only warnings for slow renders and actions, large HTML,
  public state or Inertia pages, and root render loops. It is a no-op in
  production. `examples/admin-i18n` enables it.
- `app.use(traceContextMiddleware())` accepts a validated W3C `traceparent`
  (for example from a browser OpenTelemetry SDK) and
  `openTelemetryInstrumentation(tracer, { api: { trace, context } })` parents
  Nestvexa spans on it. `@nestvexa/client` does not emit `traceparent` itself
  (client size budget); this is server-side propagation only.
- Pass the same instrumentation object to `ActionsModule.register`,
  `UploadsModule.register`, `InertiaModule.forRoot`, `RealtimeModule.forRoot`,
  `viteStaticMiddleware` and `new JobRunner` (`instrumentation` option) for
  `nestvexa.action`, `nestvexa.upload.*`, `nestvexa.inertia.render`,
  `nestvexa.ssr.render`, `nestvexa.realtime.*`, `nestvexa.asset.serve` and
  `nestvexa.job.run` spans.
- `app.use(requestTracingMiddleware(instrumentation))` (register it first)
  assigns a request id per request, echoed as `X-Request-Id` and recorded on
  every span, and emits `nestvexa.request` (method, status, response size;
  never paths, queries or headers). An inbound `x-request-id` is used only
  when `trustRequestId(request)` returns true.
- `app.useGlobalGuards(traceGuard(new SessionGuard(), instrumentation))` traces
  a host guard as `nestvexa.guard` with its class name and decision.
- Client DOM morphing runs in the browser: its timing is reported by the
  client `onDiagnostic` option, and the server records the size of the HTML
  each morph applies (`nestvexa.response_html_bytes`).

The package README lists every attribute and option.

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
the stable contract recorded in [ADR 0034](../adr/0034-devtools-browser-extension-scope.md) (which also records the
browser extension as out of scope for v1). Not shown: browser-side morph
timing and network batching (use the browser's developer tools and the client
`onDiagnostic` option), cache hit/miss and prop resolution (no hook yet).

With `DevtoolsModule.registerAsync` and the `kernel` option (the `@nestvexa/core`
`DiagnosticsRegistry`, `SecurityPolicyRegistry` and `FeatureCapabilityRegistry`), the
panel and `data.json` also list the registered security policies (configuration only,
such as Live's snapshot TTL and the upload quotas), declared capabilities and recent
kernel diagnostics; with `features: NestvexaRegistry` it also lists the installed
features and plugins (`kernel.features`, `kernel.plugins`). See the [observability README](../../packages/observability/README.md#development-panel).

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

## Testing

```sh
pnpm build && pnpm vitest run tests/observability.test.ts tests/observability-tracing.test.ts tests/observability-spans.test.ts tests/devtools-inspector.test.ts tests/devtools-browser.test.ts tests/dev-errors.test.ts
```

Package: [@nestvexa/observability](../../packages/observability/README.md). Design: [ADR 0010](../adr/0010-observability-and-performance.md).
