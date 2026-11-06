# @nestvexa/observability

Tracing, metrics and redacted structured logging for Nestvexa Live, with an
OpenTelemetry bridge and a development-only devtools panel. Optional; no runtime
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

| Span                   | Attributes                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `nestvexa.live.mount`  | `nestvexa.component`                                                                  |
| `nestvexa.live.action` | `nestvexa.component`, `nestvexa.action`, `nestvexa.revision`, `status` on HTTP errors |
| `nestvexa.live.render` | `nestvexa.component`, `nestvexa.depth`, `nestvexa.html_bytes`                         |

Public state, identity bindings, CSRF/snapshot tokens, HTML and exception messages
are never attached. Outcomes are `ok`/`error` (OpenTelemetry status OK/ERROR).
A throwing instrumentation hook never breaks a request. Browser timings remain
available through the client `onDiagnostic` option.

`nestvexa.live.render` also reports `nestvexa.state_bytes` (size of the public
state sent to the browser).

### Other packages (structural hooks)

`@nestvexa/actions`, `@nestvexa/uploads` and `@nestvexa/inertia` accept the same
`instrumentation` shape in their module options without importing this package:

| Span                       | Package / option                              | Attributes                                                                                    |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `nestvexa.action`          | `ActionsModule.register({ instrumentation })` | `nestvexa.action_group`, `nestvexa.action`, `nestvexa.error_code` on failures                 |
| `nestvexa.upload.receive`  | `UploadsModule.register({ instrumentation })` | `nestvexa.upload.mode` (`direct`/`chunked`/`form`), `.purpose`, `.bytes`, `.files`            |
| `nestvexa.upload.finalize` | same                                          | `nestvexa.upload.purpose`, `.bytes`, `.scan`                                                  |
| `nestvexa.inertia.render`  | `InertiaModule.forRoot({ instrumentation })`  | `nestvexa.page`, `nestvexa.inertia.kind` (`json`/`document`), `nestvexa.page_bytes`, `status` |

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

| Export                                                                         | Purpose                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `openTelemetryInstrumentation(tracer)`                                         | Bridge to any OpenTelemetry-shaped `Tracer` (structural; no dependency)                                 |
| `MemoryInstrumentation(capacity?, now?)`                                       | Bounded recorder with `records` and `summary()` (count, errors, p50, p95, max)                          |
| `combineInstrumentation(...targets)`                                           | Fan out spans                                                                                           |
| `redact(value)` / `createLogger(sink?)`                                        | Redacted JSON-lines logging (passwords, tokens, cookies, sessions, CSRF, snapshots, bindings, API keys) |
| `DevtoolsModule.register({ instrumentation, authorize, path?, environment? })` | HTML panel and `spans.json` at `/_nestvexa/devtools`                                                    |

## Devtools safety

`DevtoolsModule.register` throws when the environment is `production`, every request
requires the host `authorize(request)` check, responses are `no-store` with a
restrictive CSP, and only the redacted span attributes above are shown.

## Testing

```sh
pnpm build && pnpm vitest run tests/observability.test.ts tests/observability-tracing.test.ts
```

See the [observability guide](../../docs/guides/observability.md). License: MIT.
