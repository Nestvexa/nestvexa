# `nv:optimistic`

Show the expected result of an action immediately, then replace it with the
server's authoritative state when the response arrives, or roll it back when the
action fails.

```hbs
<button
  type='button'
  nv:click='toggleStar'
  nv:optimistic.toggle='starred'
>Star</button>
<output nv:text='starred'>{{starred}}</output>
```

| Declaration                         | Projection                                  |
| ----------------------------------- | ------------------------------------------- |
| `nv:optimistic.toggle="field"`      | Negates a boolean field                     |
| `nv:optimistic.set="field:literal"` | Sets a literal value                        |
| `nv:optimistic.increment="field"`   | Adds 1 (or `field:step`) to a finite number |
| `nv:optimistic.decrement="field"`   | Subtracts 1 (or `field:step`)               |

Literals are data only: `true`, `false`, `null`, a finite number with up to 15
integer and 6 fractional digits, or a single-quoted string of up to 256
characters without quotes or backslashes. Field names are top-level public state
identifiers. Expressions and other modifiers are rejected. The directive must be
on the same element as an `nv:click`, `nv:submit` or `nv:keydown` binding, and an
element may declare several projections for different fields.

## Semantics

- Projections affect display bindings only (`nv:text`, `nv:show`, `nv:bind`,
  `nv:dirty`). They are never sent to the server as model updates and never
  change server-rendered HTML.
- They apply when the action is scheduled and are removed when that action
  settles. On success the server state is already committed, so bindings show the
  authoritative value. On failure (HTTP rejection, network failure, suspension),
  the authoritative value returns and the component root dispatches a bubbling
  `nestvexa:rollback` event with `{ action, fields }`.
- A duplicate submit of a pending form does not project again.
- Optimistic display is a UI convenience, not a guarantee. The server remains
  authoritative, and the existing revision check rejects replayed or concurrent
  stale actions (`409`), so a retried click cannot apply an effect twice against
  the same snapshot revision.

Tests: [grammar and projection](../../tests/client-optimistic-navigation.test.ts),
[held and rejected requests in three browsers](../../tests/browser/projects.spec.ts).
