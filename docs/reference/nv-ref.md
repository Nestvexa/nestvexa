# nv:ref

Name an owned element so host or Alpine code can find it without a global selector:

```ts
// `element` is any element inside the component, for example its root.
const search = client.refs(element).get('search');
```

## Syntax and modifiers

The value is one identifier (`/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`, not a reserved name); dotted paths, expressions and modifiers are rejected.

`client.refs(element)` finds the Live component that owns `element` and returns a read-only `Map` from reference name to element, computed from the current owned DOM on every call. Elements inside ignored subtrees, nested Live roots and islands are not included. Two elements with the same name in one component make the call (and the component's binding pass) fail with a `DIRECTIVE` error instead of returning an arbitrary node. A reference is not stable across responses: call `refs()` again after an update rather than caching an element that a morph may have replaced.

## Server contract

None. References are client-side lookups; they are not sent to the server and grant no access to state or actions.

## Security

`refs()` returns elements the page could already reach through the DOM. It is a convenience for scoping, not an isolation boundary: code that holds a reference can read or change that element.

## Accessibility

Typical uses are focus management after a host-side step (`refs.get('search')?.focus()`) and measuring layout. When moving focus, prefer elements that are focusable natively and keep the user's own focus choice when a request completes; see [focus restoration](../guides/focus-restoration.md).

## Example

<!-- snippet: examples/starter-live/views/board.hbs -->

```html
<input
  id="board-query"
  nv:model.live.debounce.150ms="query"
  value="{{query}}"
  nv:ref="search"
/>
```

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<button type="button" nv:click="toggleVisible" nv:ref="toggle">
  Hide detail
</button>
```

## Verification

[Binding tests](../../tests/client-bindings.test.ts) and [DOM binding tests](../../tests/client-bindings-dom.test.ts) (identifier grammar, owned-DOM lookup, duplicate names rejected, ignored and nested subtrees excluded), [wrapper ownership tests](../../tests/client-ignore-self.test.ts) (references on `nv:ignore.self` wrappers) and the [grammar matrix](../../tests/client-directive-grammar.test.ts).
