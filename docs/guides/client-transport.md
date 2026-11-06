# Client transport: bundling, safe retries, negotiation and progress

The browser runtime sends one request per component at a time, in order, with a total
fetch/body deadline (`requestTimeoutMs`). This page covers the behaviour layered on that
queue. Decisions are recorded in
[ADR 0031](../adr/0031-live-protocol-evolution-and-action-replay.md).

## Bundling

Every request carries all model drafts of its component at the moment it starts. A model
synchronization (`$sync`) scheduled while another request of the same component is queued
and has not started is therefore redundant: it folds into that request instead of adding
one. Typing into several `nv:model.live` fields during a slow action produces one
follow-up request, not one per debounce. Forced refreshes (lazy loading, realtime
invalidation) are never folded.

Requests of different components are not merged into one HTTP request. Each component
has its own snapshot, revision, authorization decision and failure scope; a server batch
endpoint would have to re-run per-item admission and define partial failure, and the
spec allows batching only when those semantics hold. Cross-component batching is
deliberately not implemented.

## Safe retries with jitter

Only actions the server declares `@Action({ idempotent: true })` are retried. The server
lists them in the component marker (`data-nv-idempotent`); the client resends the
**same bytes with the same `requestId`**, which the server either runs (it never saw the
first attempt) or answers with the stored committed result (`replayed: true`). Retries
happen at most twice, after a dropped connection, a timeout, or `409`, `429`, `502`,
`503`, `504`, with full jitter (100 ms plus up to 400 ms × 2^attempt). Everything else —
`$sync`, ordinary actions, `4xx` rejections such as `422` — is never retried, so a
payment or order is never executed twice. A page script that edits the marker gains
nothing: a duplicate of a non-idempotent action is answered `409` by the server.

Read-only text streams have no automatic retry either ([text streams](text-streams.md)).

## Protocol negotiation

Successful action and `$sync` replies carry `x-nestvexa-protocol: nestvexa-live/1` and
`x-nestvexa-capabilities` (the tokens the server honours). The client sends the
capabilities it wants per request (`renderless-v1`). A reply that advertises another
protocol major, or a `426 UNSUPPORTED_PROTOCOL`, is reported as error code `PROTOCOL`
and suspends the component instead of misreading the reply; reloading the page is the
recovery (for example a long-lived tab after a deploy).

## Progress hooks

Each component root dispatches a bubbling `nestvexa:request` event:

| `detail.phase` | Other fields               | When                                    |
| -------------- | -------------------------- | --------------------------------------- |
| `start`        | `action`, `attempt: 0`     | before the first attempt                |
| `retry`        | `action`, `attempt` (1, 2) | before each automatic idempotent resend |
| `end`          | `action`, `outcome`        | after application or cleanup            |

`action` is the action id (`$sync` for model synchronization); `outcome` is
`succeeded`, `failed` or `cancelled`. The event carries no state, tokens, URLs or
payloads. Use it for progress bars or "retrying…" notices; `nv:loading` and `aria-busy`
remain the declarative indicators, and [upload progress](uploads.md) has its own
`nv:upload.progress` element.

Tests: transport rows in
[`tests/client-directive-combinations.test.ts`](../../tests/client-directive-combinations.test.ts)
(three browsers), [`tests/live-client-negotiation.test.ts`](../../tests/live-client-negotiation.test.ts)
and the dropped-request/lost-reply retry against the real server in
[`tests/browser/directive-lab.spec.ts`](../../tests/browser/directive-lab.spec.ts).
