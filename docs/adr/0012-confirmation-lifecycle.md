# ADR 0012: Confirmation is an abortable browser presentation step

Date: 2026-10-30. Status: implemented; complete Phase 4 acceptance remains open.

## Decision

Implement `nv:confirm` as bounded static text on an existing event action, with a
native default and typed promise-based host override. Apply event filters before
default prevention, scheduling before the question, and dispatch only after
literal true approval and a second ownership/configuration check. Preserve current
drafts while awaiting approval. Do not add a "confirmed" request flag or weaken
server authorization, CSRF, validation, state ownership or concurrency checks.

Track one approval per element and at most 16 per client. A configurable bounded
deadline, subtree cancellation, observation of ownership/configuration changes
and disposal settle the framework operation even if a host promise ignores abort.
After cancellation, old resolutions cannot dispatch under a newer registration.
Pass AbortSignal to the host for dialog cleanup. Mask provider exceptions rather
than including potentially sensitive UI implementation messages in errors.

## Alternatives and costs

Treating confirmation as authorization or a proof of consent was rejected because
an HTTP client can bypass DOM behavior. Automatically retrying a declined/failed
approval was rejected because the user's intent must remain explicit. Arbitrary
attribute expressions, prompt inputs and HTML message sinks were rejected to
retain a closed grammar and escaped templates.

Shipping a modal UI kit as part of this directive was rejected because native
confirmation provides a default while theme/focus choices belong to the host.
The asynchronous callback supports an accessible application dialog without adding
a dependency. Native browser prompts may be suppressed or block the event loop;
the deadline cannot force-close browser chrome, and elapsed-time verification
must reject expired results after it returns. The callback must handle its own
UI cleanup and must not use untrusted innerHTML.

The cost is a bounded map/timer per pending approval and a second owner/config
check. Waiting is not an HTTP request, so request-loading state does not start
early. Input can change while a custom dialog is pending; dispatch intentionally
uses the current validated state. `.once` consumes the approval attempt, matching
existing event invocation semantics, so cancellation does not reset `.once`.

## Compatibility and evidence

The optional callback/deadline and directive are additive alpha APIs; wire protocol,
server registration and dependencies are unchanged. Normal action bindings retain
their existing synchronous scheduling path. The custom-runtime size budget is
unchanged. [The individual reference](../reference/nv-confirm.md) documents exact
filtering, bounds, failure and native UI limitations.

[Parser tests](../../tests/client.test.ts),
[controlled browser lifecycle tests](../../tests/client-confirmation.test.ts),
[real Nest flows](../../tests/browser/confirmation.spec.ts) and
[the example](../../examples/starter-live/src/work-board.ts) exercise runtime
behavior and negative paths. The custom dialog fixture checks keyboard/Escape,
focus return, text-only rendering and axe without claiming manual screen-reader
certification or cross-platform native browser-chrome coverage.
