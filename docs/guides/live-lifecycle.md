# Request lifecycle

Live hooks are awaited application methods on a Nest-resolved component. They are
not controller routes. Host/global/component/action policies still run through
the generated Nest routes. Hook names cannot be exposed with `@Action`, `@State`
or `@Computed`. Registration rejects Nest route, parameter and enhancer decorators
on hooks because their metadata would not execute on a direct lifecycle call.

| Operation                  | Order                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount                      | boot, URL/session hydration, mount, dehydrate, beforeRender, renderer, afterRender, dispose, snapshot/session commit                                                                                    |
| Action                     | snapshot restoration, boot, hydrate, beforeUpdate/assignment/afterUpdate per field, beforeAction, action, afterAction, dehydrate, beforeRender, renderer, afterRender, dispose, snapshot/session commit |
| Synchronization            | Action order without beforeAction/action/afterAction                                                                                                                                                    |
| Resolved operation failure | onError once, dispose once; a primary disposal failure invokes onError after dispose                                                                                                                    |

Field validation precedes component resolution and hooks. Authentication, CSRF,
ownership, authorization and revision rejection do not instantiate a component
solely to call an error hook. DTO pipes remain in Nest's action pipeline. See
[update contexts](live-update-hooks.md) and [URL/session state](url-session-state.md).

Exported types are `LiveLifecycleHooks`, `LiveUpdateContext`, `LiveRenderContext`
and `ReadonlyLiveValue`. `beforeRender()` prepares data before the view model is
read. `afterRender(context)` receives frozen `{ html }`. HTML, public state and
URL effects are captured before observation and cleanup: mutations in
`afterRender` or `dispose` do not enter snapshots or remembered session state.
Do not log the HTML: it may include personal data and component tokens.

`onError(error)` observes the original server failure. Throwing there never
replaces or suppresses the original error. `dispose()` runs once per resolved
mount/action operation, including failures during boot, rendering or actions and
late observation of shutdown. Disposal failure prevents otherwise successful
snapshot/session commit; secondary cleanup failures preserve the primary error.
Store/session commit failures are observed after cleanup. These server-only hooks
are not exposed as browser actions or response data.

This is request resource cleanup, not browser unmount. An ordinary completed HTTP
request cannot tell the server that a tab later closed. Browser removal has its
own events and cleanup; Nest owns provider/application lifecycles. Rejection
before component resolution has no component resources to dispose.

Business effects may have happened before failure. Failed action transactions
revoke their uncertain token; session persistence failure revokes the advanced
token. No database rollback, email undo or automatic mutation retry is implied.
Hosts own durable transactions, idempotency and session-store persistence.

Hooks accept no arguments except the documented single update/render/error
context. Accessor hooks and unsupported argument counts fail registration. The
new hook names are reserved in this alpha: rename conflicting fields/actions
before upgrading. Legacy TypeScript decorators remain required.

[HTTP lifecycle tests](../../tests/live-lifecycle-hooks.test.ts) exercise real
Express/Fastify servers and HBS. Their shared session bag is trusted test context,
not production authentication. See also the [Nest pipeline tests](../../tests/live.test.ts).

## Nested ordering

A child mounted by `nvChild` runs its complete operation inside the parent's render,
after the parent's `beforeRender` and renderer call and before the parent's
`afterRender`:

```text
parent boot → mount → dehydrate → beforeRender
  child boot → mount → dehydrate → beforeRender → afterRender → dispose
parent afterRender → dispose
```

On a parent action, a retained child whose `@Prop`/`@Reactive` values did not change
runs no hooks and is not re-rendered; a changed value refreshes it with
boot → hydrate → beforeUpdate/afterUpdate → dehydrate → render → dispose inside the
parent render. Each hook runs exactly once per operation; parent and child share the
request context (request-scoped providers) but not transient providers. The
[pipeline tests](../../tests/live-pipeline.test.ts) pin this order on Express and
Fastify, together with middleware, guards, interceptors, pipes and filters around it.

## Deadlines and cancellation

`@LiveComponent({ timeoutMs })` (1–300000 ms, default none) bounds each hook and the
action method. Expiry fails the request with `504 HOOK_TIMEOUT` or `504 ACTION_TIMEOUT`,
runs `onError`/`dispose` and invalidates the state reference. `liveAbortSignal(this)`
returns the operation's `AbortSignal`; it aborts on the deadline and when application
shutdown begins, so pass it to `fetch`, database drivers and timers:

```ts
@LiveComponent({ name: 'report', view: 'report', timeoutMs: 5_000 })
export class Report {
  @State() rows: string[] = [];
  async mount(): Promise<void> {
    const response = await fetch('https://reports.internal/rows', {
      signal: liveAbortSignal(this),
    });
    this.rows = (await response.json()) as string[];
  }
}
```

Work that ignores the signal is abandoned, not undone. During shutdown new work answers
`503 LIVE_SHUTDOWN` and in-flight requests get up to 10 s to settle. See the
[action option tests](../../tests/live-action-options.test.ts).
