# Renderless actions

A renderless action changes component state but does not need new server HTML.
Typical uses are counters, "like" buttons, read receipts and other values that
the template already displays through local bindings (`nv:text`, `nv:show`,
`nv:dirty`, `nv:bind`).

```ts
import { Action, LiveComponent, State } from 'nestvexa';

@LiveComponent({ name: 'activity-panel', view: 'activity-panel' })
export class ActivityPanel {
  @State() likes = 0;

  @Action({ renderless: true })
  like(): void {
    this.likes++;
  }
}
```

```hbs
<output nv:text='likes' aria-live='polite'>{{likes}}</output>
<button type='button' nv:click='like'>Like activity</button>
```

## What changes and what does not

| Stage                                                          | Normal action     | Renderless action                    |
| -------------------------------------------------------------- | ----------------- | ------------------------------------ |
| Origin, CSRF, identity, rate and payload checks                | yes               | yes                                  |
| Snapshot/revision validation and replay rejection              | yes               | yes                                  |
| Host `authorize`, Nest guards, pipes, interceptors, filters    | yes               | yes                                  |
| `boot`, `hydrate`, update/action hooks, `dehydrate`, `dispose` | yes               | yes                                  |
| `beforeRender`/`afterRender`, `@Computed`, template rendering  | yes               | **skipped**                          |
| URL (`@Url`) effects and `@Session` persistence                | yes               | yes                                  |
| Response `html`                                                | rendered fragment | `""` with `renderless: true`         |
| Browser DOM                                                    | keyed morph       | retained subtree, bindings refreshed |

The server answers renderless **only** when the request carries the exact header
`x-nestvexa-capabilities: renderless-v1`. Any other value (missing, different
case, a list, a later version) receives a normal rendered response. The bundled
client sends the capability for ordinary actions. Stream refreshes, which must
replace HTML, never send it, and the client rejects a renderless reply to such a
request instead of silently keeping stale markup.

## Choosing renderless

Use it only when every value the action changes is either displayed through a
binding or not displayed at all. Conditional template blocks (`{{#if}}`),
loops and computed values are **not** refreshed by a renderless reply. If an
action sometimes needs new markup, keep it a normal action. Renderless is a
rendering optimization: it is not an authorization or confidentiality control,
and the returned public state is the same state a normal reply would carry.

## Failure behavior

Failures keep the existing contract: validation and authorization errors are
recoverable, while uncertain failures after effects revoke the snapshot so the
browser cannot replay the action. A `@Session` write failure after a renderless
action revokes the advanced state exactly like a rendered action.

Tests: [server contract](../../tests/live-renderless.test.ts),
[client protocol](../../tests/client-renderless-protocol.test.ts),
[client lifecycle](../../tests/client-transport-lifecycle.test.ts) and the
[three-browser scenario](../../tests/browser/renderless.spec.ts). The
[activity starter](../../examples/starter-live/src/activity-panel.ts) contains a
working example.
