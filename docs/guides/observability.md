# Observability

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

## API

| Export                                                                         | Purpose                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `openTelemetryInstrumentation(tracer)`                                         | Bridge to any OpenTelemetry-shaped `Tracer` (structural; no dependency)                                 |
| `MemoryInstrumentation(capacity?, now?)`                                       | Bounded recorder with `records` and `summary()` (count, errors, p50, p95, max)                          |
| `combineInstrumentation(...targets)`                                           | Fan out spans                                                                                           |
| `redact(value)` / `createLogger(sink?)`                                        | Redacted JSON-lines logging (passwords, tokens, cookies, sessions, CSRF, snapshots, bindings, API keys) |
| `DevtoolsModule.register({ instrumentation, authorize, path?, environment? })` | HTML panel and `spans.json` at `/_nestvexa/devtools`                                                    |

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
  `UploadsModule.register` and `InertiaModule.forRoot` (`instrumentation`
  option) for `nestvexa.action`, `nestvexa.upload.*` and
  `nestvexa.inertia.render` spans.

The package README lists every attribute and option.

## Devtools safety

`DevtoolsModule.register` throws when the environment is `production`, every request
requires the host `authorize(request)` check, responses are `no-store` with a
restrictive CSP, and only the redacted span attributes above are shown.

## Testing

```sh
pnpm build && pnpm vitest run tests/observability.test.ts tests/observability-tracing.test.ts
```

Package: [@nestvexa/observability](../../packages/observability/README.md). Design: [ADR 0010](../adr/0010-observability-and-performance.md).
