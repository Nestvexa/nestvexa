# ADR 0013: bounded initialization per component registration

Status: accepted for the eager alpha implementation; full lazy/deferred acceptance
remains open.

## Decision

`nv:init` names one registered action per owned component. Discovery consumes the
registration's single attempt and queues a microtask, rechecking ownership,
markers, action text and directive validity before using the ordinary serial
queue. The default client mount and Alpine startup are synchronous. Attempts are
bounded globally per mounted client (64 by default, configurable 1–1,000), with
no automatic retry. No server protocol or privileged initialization route is added.

## Alternatives and consequences

Running synchronously during discovery was rejected because the default Alpine
startup has not completed. A microtask follows the synchronous mounting turn
without adding timers; it does not promise completion of async host work. See
the [HTML microtask contract](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#microtask-queuing)
and [Alpine extension ordering](https://alpinejs.dev/advanced/extending).

Tracking individual elements was rejected because server replacement would create
render loops. Registration-scoped attempts persist across fragment replacement
and repeated mount, while independent new components can initialize. Explicit
disposal/remount can rerun: effects requiring durable deduplication need a server
idempotency policy. Suppressing all future registrations globally would instead
prevent legitimate independent components from loading.

Automatic retries were rejected because HTTP failure does not establish rollback.
A consumed canceled or failed attempt stays consumed. Native confirmation on an
initializer was rejected because startup is not a user gesture or consent record.
Visibility-based loading is deferred until a tested lazy/component scheduling
contract exists, rather than giving `.lazy` misleading eager behavior.

The extra scan is linear in initializer count per discovery, plus existing
ownership/validation costs. Capacity bounds automatic request growth, not total
document size or server business work. Existing per-component queue and transport
deadlines still apply. Host authorization and request isolation remain mandatory;
no state is shared between sessions by this browser mechanism.

## Failure modes and evidence

Same-turn removal, reconfiguration, invalid directives, ignored/island ownership,
marker changes and disposal cancel or reject dispatch. Duplicate declarations
reject the component before initial registration; later duplicates cannot bypass
the dispatch validation. Server rejection consumes the attempt without retry.
An uncertain transport failure retains the existing suspension semantics.

Contracts live in [the parser](../../packages/client/src/protocol.ts) and
[client discovery](../../packages/client/src/index.ts). See
[parser tests](../../tests/client.test.ts),
[controlled lifecycle tests](../../tests/client-lifecycle.test.ts),
[real Nest browser flows](../../tests/browser/initialization.spec.ts) and the
[directive reference](../reference/nv-init.md).
This additive alpha feature changes no wire fields or dependency requirements.
