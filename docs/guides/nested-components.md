# Nested components, events, lazy loading and redirects

A Live component can mount other registered Live components from its template.
Each child is an independent component: it has its own snapshot, revision, state,
actions, authorization checks and request queue. The parent re-renders without
touching browser-owned child DOM unless a parent-owned value changed.

## Declaring children

Children are an explicit allowlist on the parent. Templates refer to the alias,
never to a class name, and every child class must be registered in the same
`LiveModule` (`NestvexaModule.forRoot(..., { components })`) array; startup fails
otherwise.

```ts
import { Action, LiveComponent, Reactive, State } from 'nestvexa';

@LiveComponent({ name: 'team-member', view: 'team-member' })
export class TeamMember {
  @Reactive() @State() memberId = '';
  @Reactive() @State() name = '';
  @State() kudos = 0;
  @Action() thank(): void {
    this.kudos++;
  }
}

@LiveComponent({
  name: 'team-board',
  view: 'team-board',
  children: { member: TeamMember },
})
export class TeamBoard {
  @State() members = [{ id: 'ada', name: 'Ada' }];
}
```

```hbs
<ul>
  {{#each members}}
    <li>{{nvChild 'member' id memberId=id name=name}}</li>
  {{/each}}
</ul>
```

`nvChild alias key [props…]` is a trusted helper supplied by the runtime while the
parent renders. In Handlebars, props are hash arguments; engines with plain
function calls use `nvChild(alias, key, { prop: value })`. The key must be 1–128
letters, digits, `_`, `.`, `:` or `-`, and unique per alias within one parent
render. The helper returns an unforgeable placeholder (a per-render random nonce)
that the runtime replaces with the child root exactly once. A template that drops
or duplicates the helper output fails the render.

Every child root is a `<div>`. Place `nvChild` where flow content is allowed (for example inside `<li>`, `<td>` or `<section>`), never directly inside `<table>`, `<tbody>`, `<tr>`, `<ul>` or `<select>`, where the HTML parser would move it.

## Props

| Decorator (with `@State`) | Set by the parent         | Child may change it                  | On a later parent render                    |
| ------------------------- | ------------------------- | ------------------------------------ | ------------------------------------------- |
| `@Prop()`                 | at mount only             | yes                                  | ignored                                     |
| `@Reactive()`             | at mount and every render | **no** (`409 REACTIVE_PROP_MUTATED`) | child refreshed if the value changed        |
| `@Modelable()`            | via `model="parentField"` | yes, proposed back to the parent     | child refreshed if the parent value differs |

Props must target declared state fields. Reactive props cannot be client-writable
and none of these can also be `@Url` or `@Session` state. A component may declare
at most one `@Modelable` field. Unknown props fail the parent render. A
modelable child's new value is proposed to the writable parent field through the
parent's `$sync` route, so the parent's state validation still decides.

## What the parent response contains

- **New key**: a full child root (`data-nv-key="nv-child:<alias>:<key>"`), mounted
  with its own `$mount` authorization, hooks, snapshot and child bookkeeping.
- **Existing key, no parent-owned change**: an empty stub
  (`<div data-nv-component="…" data-nv-stub>`). The browser keeps the existing
  child root, including focus, drafts, Alpine state and any pending child request.
- **Existing key, reactive/modelable value changed**: the child is re-rendered in
  its own store transaction (`beforeUpdate`/`afterUpdate` hooks per changed prop)
  and returned with `data-nv-refresh`; the browser replaces that child root.
  Grandchildren of a refreshed child are grafted back from the existing DOM.
  If the child has its own request in flight, the parent keeps it as a stub.
- **Removed key**: the child root disappears and its server snapshot is revoked
  after the parent commits.

Stubs that do not match an existing child root are rejected before any DOM change.
Child snapshot references are kept server-side next to the parent snapshot; they
never appear in browser state. Depth is limited to 8 levels and 200 child renders
per tree. A parent failure revokes snapshots created during that render.

## Events

An action records events with `dispatchLiveEvent`. After the response commits,
the browser delivers each event to listening components on the page and also
fires a window `nestvexa:event` `CustomEvent` (`detail: { name, payload, source }`).

```ts
import { Action, ActionInput, OnEvent, dispatchLiveEvent } from 'nestvexa';

class TeamMember {
  @Action() leave(): void {
    dispatchLiveEvent(this, 'member.left', { id: this.memberId });
  }
}
class TeamBoard {
  @Action()
  @OnEvent('member.left')
  memberLeft(@ActionInput(MemberReferencePipe) input: { id: string }): void {
    this.members = this.members.filter((member) => member.id !== input.id);
  }
}
```

A listener is an ordinary registered `@Action`: it is authorized by the host
policy and Nest guards, and its payload arrives as action input through pipes.
**Event payloads cross the browser and are untrusted**; validate them as strictly
as any other input. A listener without `@ActionInput` must be dispatched with a
`null` payload. Options: `{ to: 'component-name' }` targets one component name,
`{ self: true }` targets only the dispatcher. Limits: 16 events per action, 16 KiB
per payload, 64 listener actions per delivered event. Browser code can dispatch
with `client.dispatch(name, payload)` or Alpine's `$live.dispatch(name, payload)`.
`dispatchLiveEvent` is only valid while an action executes; mount-time events are
not supported.

## Lazy components

`@LiveComponent({ lazy: true })` (or `lazy: 'visible'`) runs `boot`, state
hydration, `mount` and `dehydrate` at mount, stores the snapshot, and renders a
placeholder instead of the template. `placeholder: 'view-name'` renders that view
with public state; otherwise a small accessible status paragraph is used. The
client requests the first full render through the component's `$sync` route,
immediately (`lazy: true`) or when the root intersects the viewport
(`'visible'`). Hosts must authorize `$sync` for lazy components.

## Redirects

`redirectLive(this, '/path?query#hash')` navigates the browser after the action
commits. Only application-relative paths are accepted on the server and again in
the client; absolute URLs, protocol-relative URLs, backslashes and control
characters are rejected.

Tests: [server integration](../../tests/live-nesting.test.ts),
[client protocol](../../tests/client-events-protocol.test.ts),
[three-browser scenarios](../../tests/browser/nesting.spec.ts). Example:
[`/team`](../../examples/starter-live/src/team-board.ts). Design record:
[ADR 0021](../adr/0021-nested-components-and-events.md).
