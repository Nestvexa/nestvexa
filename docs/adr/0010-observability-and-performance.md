# ADR 0010: Redacted diagnostics and reproducible performance evidence

Date: 2026-10-25; bounded client transport amendment 2026-10-27. Status: **benchmark/verification and initial client transport limits exist; production diagnostics and broad performance acceptance pending**.

## Decision

Instrument explicit lifecycle boundaries with optional, typed diagnostics: request, identity/authorization result, state lookup, validation, action, render, asset lookup, response and teardown. Later client spans cover scheduling, network and DOM work. An OpenTelemetry adapter may consume those events without making a vendor SDK mandatory in core. Instrumentation failures must not alter authorization or cause state transitions to be retried.

Default diagnostic payloads contain stable event names, elapsed time, safe outcome codes and correlation IDs. They do not contain session cookies, state references, CSRF tokens, authorization headers, raw action inputs, full public state or private view models. "Public state" can still contain personal data. Production stack traces and template filesystem paths must not reach browser errors; detailed local errors are a development-only capability. Host operators own log destinations, access controls and retention.

Measure before claiming improvement. Record OS/CPU/runtime, dependency versions, exact command, fixture sizes, warmup, sample count and statistics. Compare equivalent plain Nest+HBS and Nestvexa paths on the same environment. Include cold/warm rendering, action p50/p95/p99, bytes, throughput and resource growth where implemented. Keep browser bundle size separate from Alpine/framework dependencies so exclusions are visible. The initial custom Live gzip target is 35 KB, a proposed budget rather than a measured result.

Use deterministic byte/count limits for portable CI where possible. Wall-clock thresholds need an adequately stable runner and measured variance. Performance suites must not skip correctness/security checks to improve numbers. Cache isolation, bounded records/listeners and stale-response handling are correctness requirements even if a faster unsafe alternative exists.

## Alternatives and costs

Each dispatched Live request has a 30-second default browser deadline covering fetch and response-body reading, configurable within 1–300000ms. Queued wait time is separate. Incremental body reads enforce a 2097152-byte limit on Fetch-decoded content, with bounded geometric buffer growth, strict UTF-8 and exact JSON media type checking. The deadline races the transport and reader so cleanup can settle even when an injected implementation ignores abort; custom resource release remains host-owned. Browser timers do not preempt synchronous parsing/rendering or guarantee server cancellation.

An uncertain result suspends further transport in that component and nested roots, restores loading, and retains local state access and enhanced form prevention. There is no automatic replay or clear-failure shortcut; the host must obtain authoritative state before remounting. A documented HTTP rejection allowlist preserves explicit correction flows such as state-validation 422. Private fetch/reader exception text and server error bodies are excluded from transport messages. [Transport lifecycle cases](../../tests/client-transport-lifecycle.test.ts) and [real Nest fault scenarios](../../tests/browser/request-lifecycle.spec.ts) exercise these boundaries; executed acceptance remains in the checkpoint.

Relying only on AbortSignal was rejected because custom fetch/streams can ignore cancellation and retain a permanently busy UI. Reading the full response text before checking its size was rejected because it applies the limit too late and counts UTF-16 characters instead of bytes. Automatically advancing the queue after an ambiguous result was rejected because the server may have committed an effect without returning a usable revision. Suspension costs a reload or explicit recovery; it preserves uncertain outcomes honestly rather than guessing a retry policy.

Unconditional full-state logging was rejected for privacy and secret exposure. Vendor-bound telemetry in the default distribution was rejected for dependency and operational cost. Machine-independent latency guarantees were rejected because host workload dominates. Capturing traces and statistics costs CPU/storage; sampling and opt-in debug detail must be explicit and must never weaken security event policy.

Failure modes include high-cardinality labels, user-controlled trace metadata, sink outages, leaked timers and benchmark fixtures hiding N+1 work. Redaction tests, bounded queues, cleanup tests and representative fixtures are required before diagnostics are advertised.

## Evidence and gaps

October 30 amendment: [browser timing diagnostics](../guides/client-diagnostics.md)
implement optional queue/request/morph samples with a closed three-field payload,
no identity labels or buffer, and isolated sink failures. The
[transport regressions](../../tests/client-transport-lifecycle.test.ts) verify
timing separation and failure/cancellation classification. A cleanup-triggered
abort must not mislabel an invalid fragment as user cancellation. This additive
alpha API changes neither wire format nor retry policy. The existing
[per-module size checker](../../scripts/size.mjs) retains a hard custom-client (48 KiB since [ADR 0020](0020-client-budget-revision.md))
gzip cap and explicit Alpine/maps exclusions. Server/OTel spans and comparative
production measurements remain later work.

[The current benchmark script](../../scripts/bench.mjs) measures HBS rendering only. [Lifecycle tests](../../tests/lifecycle.test.ts) exercise current engine cleanup/cache isolation. They are not production load, heap-leak or end-to-end latency evidence. Browser timing redaction tests and per-module bundle estimates now exist. OpenTelemetry integration, the broader server redaction corpus, comparison baseline, long-running memory tests, distributed throughput and render-budget diagnostics remain pending. No measured result should be copied from a target in the master specification.
