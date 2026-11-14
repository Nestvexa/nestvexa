# ADR 0005: Owner-bound state, revisions and uncertain action effects

Date: 2026-10-25; status updates 2026-11-07 and 2026-11-14. Status: **accepted and implemented in `@nestvexa/live` (experimental), including the Redis store, opt-in idempotent replay and identity locks verified on real Redis (see the status updates below); cross-replica `download` replay and full release acceptance remain open**.

## Decision

Persist only explicitly declared public component fields. Providers, private fields, methods, accessors and arbitrary class instances never enter the state record. The initial serializer accepts a bounded JSON-like domain; Date, BigInt or custom synthesizers require explicit versioned implementations and round-trip tests. Restoring a component copies only its registered state fields into a request-isolated Nest-resolved instance. Injected services must not be overwritten by client keys.

Use opaque server-state references bound to the host session, principal, tenant and component instance. Records have a bounded lifetime and monotonically increasing revision. Identity changes, logout/revocation and tenant switching invalidate reuse under the previous binding. CSRF is independent of reference possession. The host identity resolver must revalidate current authority each request.

A store mutation acquires exclusive per-instance execution rights or performs an equivalent atomic reservation against the expected revision. An old revision fails before effects occur. Successful execution validates and renders the next state before completing the transition. Browser responses carry instance/revision information; stale responses cannot overwrite later state. Queue lengths, record counts, state size, action duration and expiry cleanup are bounded.

The crucial failure rule is **fail closed when effects are uncertain**. Once an action may have changed an external system, an exception, timeout, cancellation or render failure cannot justify restoring the old token and automatically retrying. Mark the instance/reference unusable or otherwise prevent replay, return a recoverable conflict/error, and require an authorized fresh render. Application-specific idempotency keys and durable transactions are needed for orders/payments; the framework cannot roll back arbitrary service effects. Abort of a browser request does not prove that a server action stopped.

## Alternatives, costs and failure modes

Mutable singleton component instances were rejected because they leak state between users. Last-write-wins state was rejected because concurrent tabs can discard edits or duplicate effects. Distributed exactly-once claims were rejected: process crashes and external effects require application transaction design.

An in-memory store is appropriate only for development/single-process deployments. It provides no cross-replica lock and loses state on restart; startup/configuration must make that boundary explicit. Redis/custom stores require atomic revision/lock semantics, lock expiry analysis and fault tests before being advertised. Store failure must not fall back to unbound or unlocked execution. A lost lock cannot authorize a second copy of an uncertain mutation.

## Required evidence

[Current native request-isolation tests](../../tests/integration.test.ts) and [cache-isolation tests](../../tests/lifecycle.test.ts) are relevant foundations, not proof of this model. Required new tests include same-instance overlap, two users/tenants, expired references, repeated action requests, failed action after an observable effect, failed render after mutation, timeout/abort, server restart and stale browser response. Per-action idempotency remains an unmet feature until separately implemented.

## Status update (2026-11-07)

The model is implemented in `@nestvexa/live`. Owner-bound references,
revisions, failure invalidation and the store interface are covered by
`tests/live-security.test.ts`, `tests/live-protocol.test.ts`,
`tests/live-instance-scope.test.ts` and the shared
`tests/live-store-contract.test.ts`. Per-action idempotency and action
concurrency modes shipped as opt-in `@Action({ idempotent, concurrency })`
([ADR 0031](0031-live-protocol-evolution-and-action-replay.md),
`tests/live-action-options.test.ts`). The Redis store meets the atomic revision
requirement above through the same contract suite
([ADR 0032](0032-distributed-state-and-redis.md)).

Still open: fault tests for lock expiry and replica loss against real Redis,
and replay of `download` URLs on a replica other than the one that created them.

## Status update (2026-11-14)

Lock expiry now has a real-Redis fault test: the `redis-live-coordination` step
of `scripts/services-check.mjs` (`pnpm test:services`) shows a replay record
written on one store instance is read on another and expires by `PX`, an
identity lease held on one replica excludes the other until released, and a
crashed holder's lease lapses while a stale owner cannot release its
successor's lease. Entry TTL and transaction lease expiry are covered by the
same script. `tests/services/distributed.spec.ts` drives replay and the
identity lock through the Live runtime across Express and Fastify replicas.

Still open: replay of `download` URLs on a replica other than the one that
created them, and full release acceptance.
