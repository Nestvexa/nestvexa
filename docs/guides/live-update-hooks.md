# Request boot and field update hooks

Phase 4 starts with real `boot`, `beforeUpdate` and `afterUpdate` lifecycle
execution. Other Phase 4 features remain incomplete. Implement the optional
`LiveLifecycleHooks` interface from `@nestvexa/live` or the `nestvexa` umbrella.
No hook decorator or client-selected hook name is involved.

```ts
import { LiveComponent, State } from '@nestvexa/live';
import type { LiveLifecycleHooks, LiveUpdateContext } from '@nestvexa/live';

@LiveComponent({ name: 'editor', view: 'editor' })
export class Editor implements LiveLifecycleHooks {
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  title = '';
  @State() lastUpdated = '';

  afterUpdate(update: LiveUpdateContext): void {
    this.lastUpdated = update.field;
  }
}
```

Initial mounting runs host identity/authorization, resolves the registered Nest
instance, then awaits `boot → mount → dehydrate → render/store`. An action or
model-sync request passes its real Nest guards/pipes/interceptors, admission,
ownership/revision and **all** field validators before component hooks execute.
The store transaction restores the previous state and runs:

1. `boot`, then `hydrate`.
2. For each accepted top-level update, in payload property order:
   `beforeUpdate(context) → assign validated value → afterUpdate(context)`.
3. For an ordinary action: `beforeAction → action → afterAction`.
4. `dehydrate`, render, serialize and commit the next revision.

Synchronization runs field hooks but never action hooks or action-method guards.
Require explicit host `$sync` authorization and component/global policies. Hooks
also run for explicitly supplied equal values; absent fields produce no field
hook. Server changes made by an action/hook do not recursively trigger update
hooks. There is no implicit render loop or parent/child propagation.

`LiveUpdateContext` has `field`, `previous` and `value`. `previous` is the last
committed public value before this request, even if `hydrate` changes the local
instance. `value` is the validated client value. The complete context and nested
JSON values are detached and recursively frozen. Public `ReadonlyLiveValue`
types reflect that boundary. Hooks inspect these values; assignment uses a
separate mutable component value. They do not replace input validation or
authorization. Hooks are trusted application code and can intentionally change
their own instance state.

Async hooks are awaited exactly once for each entered stage. A thrown hook stops
subsequent assignment/action/render/commit. The existing memory-store rule
**revokes the token** after execution failure: it cannot prove whether a hook
already performed an external effect. Another request with that token receives
410; obtain authoritative state and mount again rather than blindly retrying.
Pure validation failures before the transaction remain recoverable. Shutdown
during an awaited hook prevents the next stage and
returns `LIVE_SHUTDOWN`. Existing Nest filters still handle errors. Already-run
external side effects are **not rolled back**, and aborting a browser request
does not cancel arbitrary server work. Keep irreversible work in explicit
authorized/idempotent business actions; no automatic retry is added.

`boot`, `beforeUpdate` and `afterUpdate` are now reserved lifecycle member names,
like `mount` and `hydrate`. State/computed/action decorators reject them, and
registration rejects accessor hooks without evaluating getters. Non-callable
instance hook fields fail explicitly. Migrate any older alpha action/state with
one of these names by renaming it and updating templates; wire protocol stays
`nestvexa-live/1`. The added lifecycle calls are an intentional pre-1.0 API change.

The [work board](../../examples/starter-live/src/work-board.ts) uses `afterUpdate`
to render the last accepted field. [Real browser checks](../../tests/browser/update-hooks.spec.ts)
exercise sync and submit under CSP. [Express/Fastify tests](../../tests/live-model.test.ts)
verify ordering, awaited execution, frozen/detached values, private error
redaction, failed-hook token revocation, validation/guard ordering, reserved
route exposure and shutdown. Remaining lifecycle error/render/dispose semantics,
server nesting, session/URL state, custom serializers and the rest of Phase 4
remain tracked rather than represented as complete.
