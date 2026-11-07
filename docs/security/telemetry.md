# Telemetry collection and retention policy

Nestvexa packages collect nothing and send nothing anywhere by default. There is
no usage reporting, no update check, no crash reporting and no network call to
any Nestvexa, vendor or third-party endpoint, in the server packages, the
browser client or the CLI.

What the packages do provide are **observability hooks**: spans, a redacting
logger, request ids and browser timing samples. All of them are off unless the
host application turns them on, and all of them hand data only to objects the
host supplies. Where that data goes, and how long it stays, is the host's
decision.

## Collection

| Source                                                                              | Default                          | Turned on by                                                                                                                                        | What is emitted                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server spans (Live, actions, uploads, Inertia, SSR, realtime, assets, jobs, guards) | Off: no `instrumentation` object | Passing `instrumentation` to `LiveModule`, `ActionsModule`, `UploadsModule`, `InertiaModule`, `RealtimeModule`, `viteStaticMiddleware`, `JobRunner` | Span name, duration, `ok`/`error` outcome, closed error codes and the attributes listed in the [observability guide](../guides/observability.md): component, action, page and job names, revisions, byte sizes and counts, transport kinds, channel kinds (the prefix before the first `:`). Never public state, identity bindings, tokens, HTML or exception messages |
| Request spans and ids                                                               | Off                              | `app.use(requestTracingMiddleware(instrumentation))`                                                                                                | `nestvexa.request` with HTTP method, status, response size and abort flag, and a generated request id echoed as `X-Request-Id`. Never paths, queries or headers. An inbound `x-request-id` is used only when `trustRequestId` allows it                                                                                                                                |
| W3C trace context                                                                   | Off                              | `app.use(traceContextMiddleware())`                                                                                                                 | Nothing new: a validated inbound `traceparent` becomes the parent of Nestvexa spans. `tracestate` is dropped. The client never sends `traceparent`                                                                                                                                                                                                                     |
| OpenTelemetry bridge                                                                | Off                              | `openTelemetryInstrumentation(tracer)`                                                                                                              | The spans above, handed to the host's tracer. Nestvexa has no OpenTelemetry dependency and configures no exporter                                                                                                                                                                                                                                                      |
| Structured logs                                                                     | Off                              | `createLogger(sink?)`                                                                                                                               | JSON lines passed through `redact()` (passwords, tokens, cookies, sessions, CSRF values, snapshots, bindings, API keys), written to the host's sink, or to the process's standard output when no sink is given                                                                                                                                                         |
| Devtools panel                                                                      | Off; refuses `production`        | `DevtoolsModule.register({ instrumentation, authorize })`                                                                                           | Recent spans, components and redacted public state (at most 8 KiB per render), served only to requests the host's `authorize` callback accepts                                                                                                                                                                                                                         |
| Render budget warnings                                                              | Off; no-op in production         | `renderBudgetInstrumentation({ inner })`                                                                                                            | Development log warnings for slow renders and large payloads                                                                                                                                                                                                                                                                                                           |
| Browser timing samples                                                              | Off: no sink, no buffer          | `createLiveClient({ onDiagnostic })`                                                                                                                | Frozen `{ phase, outcome, milliseconds }` samples to the host's callback. No identity, names, URLs, tokens, state, HTML or DOM. The client creates no performance marks and makes no request of its own for them                                                                                                                                                       |

Spans that the framework emits are a fixed list. A new attribute is a
documented, reviewed change (observability guide and package README), not a
configuration option.

## Transmission

Nestvexa transmits no telemetry. The packages' only outbound connections go to
targets the host configures for application work: the Inertia SSR server, an
S3-compatible store, a ClamAV daemon and Redis. The browser client talks only to
the endpoints in server-rendered markup. This inventory is enforced by a test
that fails when a new network primitive appears in any package source
([`tests/ssrf.test.ts`](../../tests/ssrf.test.ts), "outbound network surface").

If the host exports spans or logs (for example through an OpenTelemetry SDK and
exporter), that export is the host's own data flow and is governed by the
host's policy.

## Retention

- **In memory, bounded, per process.** `MemoryInstrumentation` keeps the most
  recent 500 spans by default (the `capacity` argument); `DevtoolsInspector`
  keeps the most recent 100 renders (`capacity` option). Older entries are
  dropped as new ones arrive. Nothing is written to disk and everything is
  gone when the process exits.
- **Browser samples** are not retained by the client at all; the host's
  `onDiagnostic` callback decides.
- **Logs and exported spans** live wherever the host's sink or exporter puts
  them. Hosts must set their own retention period and access controls, and
  should keep request ids and SSE access logs (which can contain realtime
  query tokens) out of long-lived shared stores.

## Host responsibilities

- Enable only the hooks you need, and never register `DevtoolsModule` in
  production or without host authorization (it refuses `production`).
- Keep personal data out of names you choose: component, action, page, job and
  channel-prefix names appear in spans.
- Document your own collection, export destination and retention if you turn
  any of this on; this policy covers the framework only.

## Evidence

- [`tests/observability.test.ts`](../../tests/observability.test.ts): spans carry
  names and sizes but no state, identity or errors; redacting logger; failing
  hooks never break requests; devtools refuses production and requires
  authorization.
- [`tests/observability-spans.test.ts`](../../tests/observability-spans.test.ts)
  and [`tests/observability-tracing.test.ts`](../../tests/observability-tracing.test.ts):
  the attribute sets of the package spans, request ids and trace context.
- [`tests/client-transport-lifecycle.test.ts`](../../tests/client-transport-lifecycle.test.ts):
  browser diagnostics are disabled by default and carry only phase, outcome and
  duration.
- [`tests/ssrf.test.ts`](../../tests/ssrf.test.ts): the reviewed outbound
  network inventory contains no telemetry endpoint.
