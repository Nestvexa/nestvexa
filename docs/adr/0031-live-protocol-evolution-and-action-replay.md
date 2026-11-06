# 0031 — Live protocol evolution, idempotent replay and action concurrency

Status: accepted, 2026-11-06. Extends [ADR 0002](0002-live-protocol.md) and
[ADR 0005](0005-state-and-concurrency.md).

## Context

`nestvexa-live/1` had one optional behaviour (`renderless-v1`) negotiated by exact header
equality, no published schema, error codes scattered across the runtime, and no answer
to three specification clauses: `@Action({ concurrency, idempotent })`, hook deadlines
and cancellation, and request deduplication without duplicating payment/order actions.

## Decisions

1. **Capabilities are a token list.** `x-nestvexa-capabilities` carries up to 16
   `name-vN` tokens. Known tokens are honoured, unknown well-formed tokens ignored,
   malformed headers rejected with `400 INVALID_CAPABILITIES` at admission. The previous
   exact-match behaviour treated any list as "no capability"; `renderless-v1, other-v1`
   now negotiates renderless, while malformed values such as `RENDERLESS-V1` or
   `renderless-v1, other` are rejected rather than silently ignored.
2. **Published contract.** `LIVE_REQUEST_SCHEMA`, `LIVE_RESPONSE_SCHEMA`,
   `LIVE_ERROR_SCHEMA` and `LIVE_ERROR_CODES` are exported; golden fixtures and a seeded
   parser fuzzer guard them. Additive fields, codes and capabilities are minor changes;
   anything else is a new protocol major.
3. **Idempotent replay is opt-in per action.** The key binds identity, state reference and
   `requestId`; the fingerprint binds component, action, revision, updates and input. An
   identical retry after commit returns the stored response (`replayed: true`) before
   the stale-revision check; a different payload is `422 IDEMPOTENCY_CONFLICT`. Guards,
   pipes and admission run again; the action does not.
4. **Concurrency rejects, never queues.** `component` (default) is the existing per-instance
   lock. `identity` adds a per-identity lock for the action across instances/tabs
   (`409 ACTION_BUSY`), acquired before the state transaction so the rejected request
   keeps its state. Queuing was rejected: the queued request's revision would be stale.
5. **Deadlines with real cancellation.** `@LiveComponent({ timeoutMs })` bounds each hook
   and the action; expiry answers `504`, invalidates state (effects are uncertain) and
   aborts `liveAbortSignal(this)`, which also aborts on shutdown. Shutdown waits up to
   10 s for in-flight requests before the store closes.

## Rejected alternatives

- Replaying non-idempotent actions automatically: a lost response must never turn into a
  second charge. Non-idempotent duplicates keep failing with `409 STALE_REVISION`.
- Caching replays forever or unbounded: five minutes and 1,000 entries, oldest evicted;
  eviction degrades to the safe `409`.
- A default deadline: it would change the behaviour of existing long-running actions.
  Deadlines are opt-in until a measured default exists.

## Consequences and limits

- Replays and identity locks are per process. Multi-replica deployments need sticky
  sessions until a shared Live store exists (DATA-004/005).
- The browser runtime retries only server-declared idempotent actions (see the amendment
  below); everything else is never retried automatically.
- `timeoutMs` abandons, but cannot undo, work that ignores the abort signal.

## Amendment (2026-11-06): browser negotiation, safe retries and bundling

- **Advertisement.** Successful action and `$sync` replies carry `x-nestvexa-protocol`
  and `x-nestvexa-capabilities`. The client reports another advertised major or a `426`
  as `PROTOCOL` and suspends, so a stale tab reloads instead of misreading a reply. Error
  replies come from exception filters without these headers; the status is the signal.
- **Safe retries.** The wrapper lists idempotent action ids in `data-nv-idempotent`. Only
  those are resent, with identical bytes and `requestId`, after a dropped connection,
  timeout, `409`, `429`, `502`, `503` or `504`, at most twice with full jitter
  (100 ms + up to 400 ms × 2^attempt). Replay makes a lost reply safe; a forged marker
  cannot make a non-idempotent action run twice because its duplicate is `409`.
  Rejected: retrying `$sync` (it writes state without replay) and retrying by status
  alone without a server declaration.
- **Bundling.** Each request carries every draft at the moment it starts, so a queued
  `$sync` folds into any queued request of the same component that has not started.
  Cross-component batching is rejected for now: each component has its own snapshot,
  revision, authorization and failure scope, and a batch route would need per-item
  admission and partial-failure semantics (spec 8.4 allows batching only then).
- **Size.** These features plus nested paths, checkbox groups, restored drafts, progress
  events and development inspection raised the bundle from 45,445 to 46,550 gzip
  bytes, inside the 49,152-byte budget of [ADR 0020](0020-client-budget-revision.md).

Evidence: [client transport guide](../guides/client-transport.md),
[negotiation tests](../../tests/live-client-negotiation.test.ts), transport rows of the
[directive matrix](../../tests/client-directive-combinations.test.ts) and the real-server
retry in [the directive lab](../../tests/browser/directive-lab.spec.ts).

## Evidence

[Protocol contract tests](../../tests/live-protocol-contract.test.ts),
[action option tests](../../tests/live-action-options.test.ts) (Express and Fastify),
[renderless tests](../../tests/live-renderless.test.ts),
[protocol reference](../reference/live-protocol.md).
