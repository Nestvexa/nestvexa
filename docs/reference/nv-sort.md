# nv:sort

Submit an item-order proposal to a registered action using pointer dragging or
keyboard shortcuts. The server validates the proposal and returns authoritative
HTML; the client does not move DOM items optimistically.

```hbs
<p>Focus a move button, then use Alt+Up/Down, Alt+Home or Alt+End.</p>
<ol nv:sort='reorder' aria-label='Project priorities'>
  {{#each tasks}}
    <li nv:sort.item='{{id}}' data-nv-key='{{id}}'>
      <button type='button' nv:sort.handle aria-label='Move {{title}}'>
        Move
        {{title}}
      </button>
      <span>{{title}}</span>
    </li>
  {{/each}}
</ol>
```

Use the existing stable morph key attribute (`data-nv-key`) when server responses
change item order so retained controls and nested ownership can be reconciled.
Give interactive handles their own stable `id` or `data-nv-key` when their
surrounding label nodes can be inserted or replaced during a response.
Keep labels and titles escaped through the template engine.

## Closed grammar and semantics

- `nv:sort='reorder'` names a registered action, never a JavaScript expression or
  method path. No modifiers are accepted.
- `nv:sort.item='task-123'` identifies an owned direct item. IDs are 1–64 ASCII
  letters, digits, underscores or hyphens, starting with a letter or digit.
  `constructor`, `prototype` and `__proto__` are rejected. IDs must be unique
  within the list. They are public identifiers, not authorization tokens.
- `nv:sort.handle` has an empty value and belongs to exactly one native
  `<button type='button'>` per item. Each handle needs a nonempty accessible name,
  supplied by text, `aria-label` or resolvable `aria-labelledby` references.

A list must have 1–200 direct items. Omit `nv:sort` on an empty-state view. Native
`ol`/`ul` lists require direct `li` items; custom elements require `role='list'`
and direct `role='listitem'` children. Lists need `aria-label` or
`aria-labelledby`. Labels are bounded to 256 characters. Foreign renderer roots
and whole-ignore subtrees are excluded. A sortable item itself cannot belong to
another renderer; separately owned content inside an item remains independent.

Handles cannot also own Live click/submit/key/model/confirmation or presentation
directives controlling visibility or disabled state. Nested interactive elements
inside a handle are rejected. Keep independent actions on separate buttons.
Default capacity is 64 sortable lists per mounted controller; manual controller
configuration accepts `maxLists` from 1 through 256. Server-side limits remain
independent.

## Pointer, touch and keyboard interaction

Native HTML dragging starts only from a registered handle. In a single-column
list, dropping above an item's vertical midpoint proposes insertion before it and
below proposes insertion after it. When items share rows (a CSS grid or wrapping
flex layout, detected from the live item geometry at each gesture, so responsive
layouts keep working) the horizontal midpoint decides, mirrored for
right-to-left lists. Dropping on a connected list's free area appends to it.
Drags into unconnected lists and external drags are ignored. The runtime tracks
the source in memory and never reads identities or HTML from `DataTransfer`.
An opaque marker enables engines requiring drag data; it grants no permission.
Escape, drag end, window blur, disposal and ownership/configuration changes cancel
the current drag.

Touch and pen use Pointer Events, because most touch browsers do not start native
HTML drags (or need a long press). A primary non-mouse pointer pressed on a handle
and moved more than 8 CSS pixels proposes a drop where it is released; a shorter
tap stays an ordinary button press. While registered, handles get
`touch-action: none` through the CSSOM (no inline style attribute is parsed, so
it is allowed under a strict `style-src`) and the previous value is restored on
release. `pointercancel` (for example a system gesture) cancels the move.

With focus on a handle:

| Shortcut                    | Proposal                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| Alt+ArrowUp / Alt+ArrowDown | Up/down one position; in a grid, up/down one row                          |
| Alt+ArrowLeft / Right       | In a grid, one position in the visual direction                           |
| Alt+Home / Alt+End          | Move to the first/last position                                           |
| Alt+Shift+ArrowLeft / Right | Connected lists: same position in the previous/next list (document order) |

In a single-column list Alt+Left/Right are left to the page and assistive
technology. Boundary moves are no-ops. Other shortcuts, additional system
modifiers, composition and key-repeat events do not propose orders. Only the
relevant handle context captures a supported shortcut, and `aria-keyshortcuts`
lists the shortcuts a handle accepts. Supply visible instructions because
assistive technology or operating-system shortcuts may conflict; manual screen
reader acceptance remains necessary.

While a proposal is pending, duplicate sort requests for that list (and, for a
cross-list move, for both lists) are blocked.
All handles receive `aria-disabled='true'`; nonfocused handles are also natively
disabled. The focused handle remains focusable while its handlers refuse new
requests, preserving keyboard context during the server round trip. A polite,
atomic status paragraph next to the list announces pending, accepted and rejected
orders. A list that is also a Live component root keeps the Live client's existing
ownership of its `aria-busy` attribute.

Repeated discovery does not install duplicate listeners. Removal, reconfiguration,
ignored/island ownership handoff and disposal release listeners and drag state.
Captured attributes are restored only when still owned by the controller, so later
host changes are preserved. Aborting browser work cannot undo an action already
running on the server.

## Server contract and security

An unconnected list's action receives its proposed order:

```json
{ "ids": ["task-b", "task-a", "task-c"] }
```

Connected lists send the moved item and the proposed order of every list it left
or entered, keyed by `nv:sort.group` (one key for a move within a list, two for a
move across lists):

```json
{
  "item": "docs",
  "lists": { "todo": ["tests", "audit"], "done": ["docs", "ship"] }
}
```

Treat this as a proposal over the union of the named lists: check that the keys
are lists the user may change and that the combined IDs are exactly the
authoritative items of those lists.

Use `@ActionInput()` with an ordinary Nest pipe/DTO to reject unknown keys, invalid
IDs, duplicates and oversized arrays. Inside the authorized action, compare the
entire proposed set with the authoritative current set accessible to that user
and tenant, then persist the order atomically. Reject foreign IDs, missing items,
stale lists and unauthorized changes. Never create an entity or resolve a service
from these identifiers. Keep the underlying order state locked against client
state writes. The normal CSRF, origin, ownership, revision, guard and validation
pipeline applies.

The controller sends an immutable proposal through the normal action queue.
Only server-rendered response HTML commits the displayed order. On rejection the
previous DOM remains, pending attributes are restored, and the host receives an
error; there is no automatic mutation retry. An accepted server may choose a
different canonical order. Client disabled state and item IDs are not security
controls. Without JavaScript, render normal ordering forms/routes if the workflow
requires a progressive fallback; the directive supplies no no-JS endpoint.

The [focused Chromium corpus](../../tests/client-sort.test.ts) covers actual native
dragging, keyboard proposals, focus, pending deduplication, strict semantics,
external-data rejection, ownership cancellation, cleanup and automated axe checks,
plus grid geometry (left-to-right and right-to-left), connected-list keyboard,
drag and empty-list drops, and touch/pen pointer gestures.
[`tests/browser/client-chunks.spec.ts`](../../tests/browser/client-chunks.spec.ts)
runs connected columns and a photo grid against a real Nest action in Chromium,
Firefox and WebKit. The sort code loads as an on-demand chunk
([ADR 0035](../adr/0035-client-feature-chunks.md)): a sortable component
registers once `live-sort.js` has loaded.
Its controlled acknowledgement fixture is not a substitute for the real Nest
integration and cross-browser acceptance tests. Consult the current implementation
report for executed coverage and remaining Phase 4 gates.

The pointer implementation follows [HTML drag-and-drop](https://html.spec.whatwg.org/multipage/dnd.html).
Keyboard scope, shortcuts and live feedback draw on the
[WAI rearrangeable-list accessibility guidance](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-rearrangeable/),
while retaining ordinary list/button semantics rather than declaring a listbox.
