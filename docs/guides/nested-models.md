# Nested model paths, checkbox groups and restored drafts

`nv:model` binds native form controls to public Live state. Beyond top-level scalars and
[multiple selects](multiple-select.md) it supports dotted paths into object state,
checkbox groups over array state, radio groups on any path, and browser-restored values.
The server stays the authority: every client write is validated again before component
code runs.

## Nested paths

A path is up to eight identifier segments (`address.city`, `settings.geo.lat`). There are
no array indices, wildcards or expressions. `nv:text`, `nv:show`, `nv:bind` and `nv:dirty`
accept the same paths; `nv:dirty="address"` also reflects drafts of `address.*`.

```ts
@State({ writable: ['city', 'zip'] })
address = { city: 'Cairo', zip: '11511', verified: false };
```

```html
<input nv:model="address.city" value="{{address.city}}" />
<input nv:model.live="address.zip" value="{{address.zip}}" />
<span nv:dirty="address" hidden>Unsaved address</span>
```

The client keeps one draft per path. A request sends the whole top-level field: the
current server value with every dirty leaf applied, so two edited leaves of one field
travel together and siblings changed by the server are not reverted. A path that does not
resolve to an existing leaf of plain object state is rejected locally (`DIRECTIVE`) and
never sent.

### Server allowlist

`@State({ writable: [...] })` lists the nested paths, relative to the field, that the
client may change. Paths use identifier segments only, at most 64 paths of depth 8, unique
and not nested in each other; they cannot be combined with a synthesizer. For each update
the runtime compares the proposed object with the stored value **before** hooks, guards on
the action method or the action run:

| Difference                                             | Result              |
| ------------------------------------------------------ | ------------------- |
| Only allowlisted leaves changed, same JSON kind        | accepted            |
| Any other leaf changed (for example `verified`)        | `422 STATE_LOCKED`  |
| A key added or removed at any level                    | `422 STATE_LOCKED`  |
| An allowlisted leaf changed its JSON kind (incl. null) | `422 STATE_TYPE`    |
| The `validate` callback (still run on the whole value) | `422 STATE_INVALID` |

A rejection consumes nothing: the same revision keeps working. `writable: true` keeps
whole-field replacement. `describeLiveState()` reports `writablePaths` so integrations
can refuse broader writes. The allowlist is a write filter, not authorization: actions
must still check ownership, tenant and permissions.

## Checkbox groups

Checkboxes whose field holds an array form one group. The value is the checked boxes'
`value`s in document order, converted by the declared cast, unique and bounded like
multiple-select arrays (256 items, 16 KiB). `.number` is allowed for groups; a single
boolean checkbox still rejects `.number` when read.

```html
<input type="checkbox" value="news" nv:model="topics" />
<input type="checkbox" value="tips" nv:model="topics" />
<input type="checkbox" value="beta" nv:model="topics" />
```

Server arrays project into `checked` without rewriting defaults or dispatching events, so
an authoritative response that drops an item unchecks it. Groups may alias a multiple
select of the same cast; a scalar control aliasing an array field rejects. Native reset
resets a group as one value. As for multiple selects, validate count, item type and
allowlist on the server (the [directive lab](../../examples/directive-lab/src/main.ts)
does).

## Radio groups, files and editable content

- Radio groups work on top-level fields and nested paths; an unchecked radio is never a
  state change.
- `nv:model` on `<input type="file">` is rejected with a pointer to
  [`nv:upload`](uploads.md), which uploads the files and models the resulting tokens.
- `contenteditable` elements cannot carry `nv:model`. Editor HTML is never exposed as
  state; use a form control or an island that writes through `$live.set`.

## Restored drafts

Browsers restore form values on reload, history navigation and autofill, before the
client mounts. At registration the client compares each model control with the default
the server rendered (`defaultValue`, `defaultChecked`, `defaultSelected`). A control the
browser changed, whose value is valid and differs from server state, becomes a draft:
`nv:dirty` shows it, the next request carries it, and the root dispatches a bubbling
`nestvexa:restored` event with `{ fields }` (names only). Controls rendered without a
value attribute are not mistaken for edits, and unrepresentable restored values (for
example text in a `.number` field) stay native-only and are never sent. Persisted
BFCache pages keep their client and drafts (see [default Live setup](default-live-setup.md)).

Tests: [`tests/client-directive-combinations.test.ts`](../../tests/client-directive-combinations.test.ts)
(nested paths, checkbox groups, restored drafts in Chromium, Firefox and WebKit),
[`tests/client-models.test.ts`](../../tests/client-models.test.ts),
[`tests/live-writable-paths.test.ts`](../../tests/live-writable-paths.test.ts) (Express and
Fastify) and [`tests/browser/directive-lab.spec.ts`](../../tests/browser/directive-lab.spec.ts).
