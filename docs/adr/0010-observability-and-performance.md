# ADR 0010: Redacted diagnostics and reproducible performance evidence

Date: 2026-10-25. Status: **benchmark/verification foundations exist; production diagnostics and broad performance acceptance pending**.

## Decision

Instrument explicit lifecycle boundaries with optional, typed diagnostics: request, identity/authorization result, state lookup, validation, action, render, asset lookup, response and teardown. Later client spans cover scheduling, network and DOM work. An OpenTelemetry adapter may consume those events without making a vendor SDK mandatory in core. Instrumentation failures must not alter authorization or cause state transitions to be retried.

Default diagnostic payloads contain stable event names, elapsed time, safe outcome codes and correlation IDs. They do not contain session cookies, state references, CSRF tokens, authorization headers, raw action inputs, full public state or private view models. "Public state" can still contain personal data. Production stack traces and template filesystem paths must not reach browser errors; detailed local errors are a development-only capability. Host operators own log destinations, access controls and retention.

Measure before claiming improvement. Record OS/CPU/runtime, dependency versions, exact command, fixture sizes, warmup, sample count and statistics. Compare equivalent plain Nest+HBS and Nestvexa paths on the same environment. Include cold/warm rendering, action p50/p95/p99, bytes, throughput and resource growth where implemented. Keep browser bundle size separate from Alpine/framework dependencies so exclusions are visible. The initial custom Live gzip target is 35 KB, a proposed budget rather than a measured result.

Use deterministic byte/count limits for portable CI where possible. Wall-clock thresholds need an adequately stable runner and measured variance. Performance suites must not skip correctness/security checks to improve numbers. Cache isolation, bounded records/listeners and stale-response handling are correctness requirements even if a faster unsafe alternative exists.

## Alternatives and costs

Unconditional full-state logging was rejected for privacy and secret exposure. Vendor-bound telemetry in the default distribution was rejected for dependency and operational cost. Machine-independent latency guarantees were rejected because host workload dominates. Capturing traces and statistics costs CPU/storage; sampling and opt-in debug detail must be explicit and must never weaken security event policy.

Failure modes include high-cardinality labels, user-controlled trace metadata, sink outages, leaked timers and benchmark fixtures hiding N+1 work. Redaction tests, bounded queues, cleanup tests and representative fixtures are required before diagnostics are advertised.

## Evidence and gaps

[The current benchmark script](../../scripts/bench.mjs) measures HBS rendering only. [Lifecycle tests](../../tests/lifecycle.test.ts) exercise current engine cleanup/cache isolation. They are not production load, heap-leak or end-to-end latency evidence. OpenTelemetry integration, redaction corpus, browser bundle measurements, comparison baseline, long-running memory tests, distributed throughput and render-budget diagnostics remain pending. No measured result should be copied from a target in the master specification.
