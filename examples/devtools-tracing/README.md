# Devtools and tracing

Run `pnpm build`, then `pnpm --filter @nestvexa/example-devtools-tracing start`
(port `4340`, or `PORT`). Visit `http://127.0.0.1:4340`.

A Live `meter` component on Express with the development panel and the
OpenTelemetry adapter wired end to end:

- **Tracing.** The page's Live client is created with `tracing: true`, so
  every Live request carries a W3C `traceparent`. `traceContextMiddleware`
  validates it and `openTelemetryInstrumentation(tracer, { api: { context,
trace } })` parents the server spans on it. The tracer comes from the
  official `@opentelemetry/sdk-trace-base` (`BasicTracerProvider` with an
  `InMemorySpanExporter`); `/api/traces` lists the finished spans in
  development. Replace the exporter with OTLP for a real backend. Both
  OpenTelemetry packages are dependencies of this example only; Nestvexa
  itself talks to `@opentelemetry/api` structurally. The header is
  correlation data, never a credential: a request with a valid `traceparent`
  and a forged CSRF token is still refused.
- **Development panel.** `DevtoolsModule` (development only, loopback
  clients only) at `/_nestvexa/devtools` with a `DevtoolsInspector`. The page
  loads `devtoolsReporter` from `@nestvexa/observability/devtools-client`
  (served at `/assets/devtools-client.js` in development) and passes its
  `onDiagnostic` to the client, so the panel shows browser morph timing and
  network batches (requests per component with request and response bytes,
  and their trace ids).
- **Cache.** `bump` reads a cached plan through `@nestvexa/cache` whose
  `onEvent` feeds `inspector.cacheEvent`: the first lookup misses, later ones
  hit, and "Invalidate plan" removes the tagged entry. The panel's Cache
  section shows the counts per namespace.

In production (`NODE_ENV=production`) the inspector, the panel, the reporter
asset and `/api/traces` are not registered, and the client sends no
diagnostics; the OpenTelemetry bridge stays.

The session is an anonymous demonstration identity, not a login system; see
`examples/live-counter` for the production caveats that apply here too.

The browser suite is `tests/browser/devtools-tracing.spec.ts`.
