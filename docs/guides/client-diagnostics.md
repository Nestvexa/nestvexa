# Browser timing diagnostics

`createLiveClient({ onDiagnostic })` opts into a synchronous, typed sink. The
default client collects nothing, retains no diagnostic buffer, creates no
performance marks and sends no telemetry. Use a trusted application entry when
you need this option; the automatic umbrella boot does not install a sink.

```ts
import { createLiveClient, type LiveDiagnostic } from '@nestvexa/client';

const samples: LiveDiagnostic[] = [];
const client = createLiveClient({
  onDiagnostic(sample) {
    // Bound retention in your own development tooling.
    if (samples.length < 100) samples.push(sample);
  },
});
client.mount();
```

Each frozen sample has `phase`, `outcome`, `milliseconds` and the registered
`component` name (public, as in the component's markup). `request` samples also
carry `requestBytes` (the request body) and, when a response body was read,
`responseBytes`; with the `tracing` option every sample carries the request's
`traceId`. Phases are `queue`, `request` and `morph`; outcomes are `succeeded`,
`failed` and `cancelled`. No identity, action name, request ID, URL, token,
state, HTML, error text or DOM element is exposed. A throwing sink is isolated
and never retries an action. Hosts still control access, retention and any
additional data they log.

In development, `devtoolsReporter()` from `@nestvexa/observability/devtools-client`
is a ready-made sink: it batches samples to the development panel, which shows
browser morph timing and network batches per component
([observability guide](observability.md#development-panel)).

## Trace context

`createLiveClient({ tracing: true })` sends a W3C `traceparent` header
(version 00, a new random trace and span id, sampled) with every Live request;
automatic retries of an idempotent action resend the same header. Pass a
function instead to continue a browser tracing SDK's trace:
`tracing: () => currentTraceparent()`. A value that is not a well-formed,
lowercase, non-zero version-00 header (or a throwing function) sends no header
and never blocks the request. On the server, `traceContextMiddleware` and the
OpenTelemetry bridge from `@nestvexa/observability` join that trace. The header
is correlation data only: the server never uses it for authentication,
authorization or CSRF.

Timing uses the owning window's monotonic `performance.now()` clock, as defined
by [High Resolution Time](https://www.w3.org/TR/hr-time-3/). Values are finite,
nonnegative milliseconds; resolution depends on the browser's privacy policy.
There are no universal latency thresholds or claims of improvement.

- `queue`: accepted scheduling until transport dispatch; its outcome describes
  the operation's final application result.
- `request`: dispatch through bounded response-body consumption. A successfully
  decoded transport can be followed by a failed protocol or DOM validation.
- `morph`: response validation, fragment preparation, reconciliation, bindings,
  discovery and synchronous update hooks. It is absent if that phase never starts.

Samples emit together after application or failure cleanup, before the scheduler
settles pending/loading counts. Nothing emits for a coalesced model update,
duplicate submit, invalid input or queued request that never dispatches. Disposal
reports cancellation for dispatched work; failure cleanup aborting a request
still reports failure. Cancellation does not establish server rollback.

Tests in [the controlled Chromium transport suite](../../tests/client-transport-lifecycle.test.ts)
exercise queue separation, immutable/redacted payloads, disabled collection,
throwing sinks, rejected HTTP, invalid fragments and disposal;
[tests/client-tracing-realtime.test.ts](../../tests/client-tracing-realtime.test.ts)
covers the `traceparent` header, sizes and trace ids. Those tests are
browser instrumentation tests, not server performance benchmarks.

`pnpm size:check` measures the emitted custom client modules and checks the
48 KiB gzip budget ([ADR 0020](../adr/0020-client-budget-revision.md)). The JSON report breaks down every
module and explicitly excludes Alpine, its adapter and source maps. It is not an
observed compressed HTTP transfer size or the complete startup cost.

This additive alpha API changes no Live wire fields; `tracing` adds only the
standard `traceparent` request header.

## Development instrumentation

`createLiveClient({ development: true })` is a development feature gate. It enables
`client.inspect()` and mirrors every reported client error to `console.warn` as
`[nestvexa] <code> <message>` (messages never contain state, tokens or server bodies).
Without the option `inspect()` throws `DIRECTIVE`; the automatic umbrella boot never
enables it, so keep it out of production entries.

`inspect()` returns frozen summaries, one per registered component: `id`, `name`,
`revision`, `pending` (queued or running requests per action, `$sync` for model
synchronization), `dirty` (field and nested-path **names** with drafts, never values),
`invalid` (count), `failure` (the error code that suspended it, or `null`) and
`idempotent` (server-declared retryable actions). Snapshot references, CSRF tokens,
endpoints, state values and payloads are never included; a test asserts a typed draft,
the CSRF token, the snapshot reference and the endpoint are absent from the JSON. For
request progress in production UIs use the `nestvexa:request` event described in
[client transport](client-transport.md).
