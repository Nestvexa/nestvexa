# ADR 0011: Authorized request boot and immutable field update hooks

Date: 2026-10-30. Status: implemented first Phase 4 lifecycle slice; full Phase 4
acceptance remains open. Phase 3 was accepted first in local commit `4571055`.

## Decision

Add awaited `boot`, `beforeUpdate` and `afterUpdate` behavior to the existing
request-isolated Live runtime, with the public `LiveLifecycleHooks` and
`LiveUpdateContext` contracts. All admission, owner/revision checks and whole-batch
pure state validation precede component execution. Initial boot precedes mount;
subsequent boot follows state restoration and precedes hydrate. Each supplied
field then receives before-hook, assignment and after-hook in payload order.
Synchronization executes these field hooks without invoking an action or its
method guards. Authorization continues through host `$sync` and Nest class/global
policies; hooks never become remote endpoints by name.

Context contains only field name, previous committed public value and validated
incoming value. Clone and recursively freeze both values independently of mutable
component state. Preserve the existing store rule: any execution callback failure
revokes its token rather than permitting an uncertain retry. Check shutdown before
and after each awaited hook. This does not interrupt arbitrary ongoing work or
roll back effects in application services.

## Alternatives, costs and failures

Running hooks before authorization/validation was rejected because application
code could perform effects on rejected input. Validating and applying one field
at a time was rejected because a later invalid field could follow earlier effects.
Sharing mutable context was rejected because retained references could modify
validated input or stored state. Hooks receive detached values at the cost of
bounded JSON cloning/freezing; no whole-user/provider context is serialized.

Retaining a failed callback's token was rejected for the same reason as failed
actions: an external side effect might already have committed. Revocation costs
an authoritative reload/remount. Automatically retrying a hook or pretending that
state non-commit rolls back services was rejected. Hook authors own their effects
and should keep irreversible work in explicit authorized/idempotent actions.

Getter hooks are rejected during registration without invocation, and hook member
names cannot be decorated as public state, computed or actions. Non-callable
instance hook fields fail explicitly. Async hooks can still hang without a future
execution deadline; no server cancellation or complete dispose/error lifecycle is
advertised by this slice.

## Compatibility and evidence

This is an intentional pre-1.0 reserved-name change: rename older alpha
state/action members named `boot`, `beforeUpdate` or `afterUpdate`. No wire fields,
browser runtime modules or dependency versions change. The
[migration and ordering guide](../guides/live-update-hooks.md) defines behavior.

[The implementation](../../packages/live/src/runtime.ts),
[public types](../../packages/live/src/lifecycle.ts),
[Express/Fastify regressions](../../tests/live-model.test.ts) and
[real Nest browser flow](../../tests/browser/update-hooks.spec.ts) cover ordering,
async waits, immutable context, validation/guard denial, revocation after failed
hooks, reserved exposure and shutdown. The [HBS work board](../../examples/starter-live/src/work-board.ts)
is the first application consumer. Full nesting, computed invalidation, complex
serializers and the remaining lifecycle states remain separate requirements.
