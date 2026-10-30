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

Each frozen sample has exactly `phase`, `outcome` and `milliseconds`. Phases are
`queue`, `request` and `morph`; outcomes are `succeeded`, `failed` and `cancelled`.
No identity, component/action name, request ID, URL, token, state, HTML, error text
or DOM element is exposed. A throwing sink is isolated and never retries an
action. Hosts still control access, retention and any additional data they log.

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
throwing sinks, rejected HTTP, invalid fragments and disposal. Those tests are
browser instrumentation tests, not server performance benchmarks.

`pnpm size:check` measures the emitted custom client modules and checks the
unchanged 35KiB sum-of-per-module gzip budget. The JSON report breaks down every
module and explicitly excludes Alpine, its adapter and source maps. It is not an
observed compressed HTTP transfer size or the complete startup cost.

This additive alpha API changes no Live wire fields. Server spans, OpenTelemetry,
sampling, a devtools panel and distributed measurements belong to later phases.
