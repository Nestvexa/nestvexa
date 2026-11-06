# 0017 — Server-approved order inputs and read-only text streams

Status: accepted for the experimental alpha implementation; full Phase 4 and
release acceptance remain open.

## Context and decision

Sorting needs a structured order proposal, while a streamed read must not hold a
mutation transaction or replay an action. Extend the existing client `call`
operation with one bounded plain JSON input. Copy and freeze it at enqueue,
without freezing caller data or evaluating accessors. Preserve existing calls
with a null wire input. Reject combined oversized requests before dispatch.

`nv:sort`, `.item` and `.handle` form a closed grammar around semantic lists and
native labelled buttons. Keyboard and same-list native drag events propose IDs;
only normal authorized server responses change item order. A Nest pipe validates
the input and the application checks its exact authorized set. Client IDs and
disabled state never grant authority. Reconcile controller-owned drag attributes
before morphing so retained listeners do not outlive the attributes enabling
native drag behavior.

Use a separate `nestvexa-stream/1` NDJSON transport for explicit read-only text
streams. A static trusted endpoint map separates IDs in markup from route URLs.
Ordinary host Nest POST routes select a constant registered component and stream
ID, obtain runtime authorization and return `StreamableFile`. Their normal Nest
pipeline remains authoritative; no method metadata is manually invoked.

Authorization rechecks identity, binding, CSRF, read policy, expiry and revision
around each awaited chunk. Text-node rendering, byte/chunk/time limits,
backpressure and per-application/component quotas bound transport work.
Cancellation retains a producer's quota lease until outstanding work settles.
The runtime cancels streams in `beforeApplicationShutdown`, before HTTP adapter
closure. Host providers must implement cancellation/timeouts for external I/O.

Mutable component objects must be fresh for each operation, including same-type
siblings in one request. Public `ModuleRef.create(type, context)` constructs
explicitly registered types while retaining the actual request's dependency
context. This fixes request-context `resolve` reuse without creating a private
DI container. It is a prerequisite for keyed server nesting, not its completion.

## Alternatives and tradeoffs

- Reject arbitrary directive expressions, client-selected routes, method paths
  and class names: they expand exposure and complicate CSP and authorization.
- Reject optimistic DOM sorting here: a server rejection otherwise requires
  restoring focus, ownership and concurrent local edits. Independent later
  optimistic APIs require their own contracts.
- Reject holding a Live mutation lock for a read stream: slow clients would
  block normal actions. A changed revision instead invalidates subsequent chunks.
- Reject streamed HTML: text has a clear escaping and ownership boundary. HTML
  fragments require a separately reviewed safe rendering protocol.
- Reject releasing capacity immediately when a promise ignores cancellation:
  repeated requests could create unbounded orphan provider work. The tradeoff is
  reduced availability until an uncooperative provider settles or is restarted.
- Reject a bespoke HTTP/websocket stack: Nest's route pipeline and Node streams
  already provide the required integration. These quotas remain process-local.

## Failure modes, cost and compatibility

A permission change is checked at explicit boundaries; it is not an atomic
transaction with an arbitrary external service. Partial text may remain visible
after failure, and reads do not automatically retry. Hosts must provide clear
incomplete/error status and resource-level policies. Native dragging supports
vertical same-list movement; keyboard shortcuts and visible instructions are
provided, with manual assistive-technology review still required.

The bundled custom client grows but remains subject to the hard
gzip budget (35 KiB at that checkpoint; revised by ADR 0020), excluding Alpine. No renderer, cloud or broker dependency is added.
Fresh component construction changes accidental same-request object reuse;
applications must share ordinary providers instead of mutable component objects.
The documented context/scope behavior is tested only on the supported Nest
version until another version passes those contracts.

## Implementation and evidence

- [Client input validation](../../packages/client/src/action-input.ts),
  [sort controller](../../packages/client/src/sort.ts),
  [stream receiver](../../packages/client/src/stream.ts),
  [server stream helper](../../packages/live/src/text-stream.ts), and
  [authorization/lifecycle](../../packages/live/src/runtime.ts).
- [Input corpus](../../tests/client-action-input.test.ts),
  [queued input and transport corpus](../../tests/client-transport-lifecycle.test.ts),
  [sort corpus](../../tests/client-sort.test.ts),
  [stream receiver corpus](../../tests/client-stream.test.ts),
  [Express/Fastify streams](../../tests/live-stream.test.ts), and
  [DI scope contracts](../../tests/live-instance-scope.test.ts).
- [Real sorting](../../tests/browser/sort.spec.ts) and
  [streaming](../../tests/browser/stream.spec.ts) browser acceptance; the
  [implementation status](../implementation/STATUS.md) identifies executed runs.

## Amendment (2026-11-06): HTML stream fragments and sort browser rows

`nv:stream` stays **text-only**; HTML fragment streaming is deliberately not
implemented. A streamed fragment would be applied before the action commits, outside the
revision check that guards every morph, and partial HTML cannot pass the closed fragment
and directive validation that runs on a complete response (an unterminated element or
attribute changes meaning with the next chunk). Applying HTML per chunk would also break
the single authoritative renderer rule (spec 8.2) for the target subtree and the Trusted
Types sink discipline. Progressive HTML is served by ordinary actions (one validated
morph), `nv:stream` text into a text-only target, or `nv:poll`/realtime refreshes. The
spec's "safe text/HTML semantics" is met by escaping: chunks are inserted as text and can
never create elements.

Sort keyboard moves (Alt+Arrow/Home/End, ignored unmodified/Shift/Control arrows, edges),
native pointer drag (upper/lower half), blocking while pending with `nv:loading` and
inertness inside `nv:ignore` now run as combination rows in Chromium, Firefox and WebKit
([matrix](../../tests/client-directive-combinations.test.ts)); keyboard and pointer moves
are applied by a real server in [the directive lab](../../tests/browser/directive-lab.spec.ts).
Touch, grid and cross-list movement remain unsupported.
