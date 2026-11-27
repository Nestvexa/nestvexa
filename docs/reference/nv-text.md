# nv:text

Keep an owned element's text in step with one public state value:

```hbs
<p role='status' nv:text='status'>{{status}}</p>
```

## Syntax and modifiers

The value is a public state field or a dotted path of at most eight identifier segments (`address.city`). There are no modifiers: `nv:text.html`, expressions, array indices, empty values and reserved names (`constructor`, `__proto__`, `prototype`) are `DIRECTIVE` errors.

The resolved value must be a string, a boolean, a finite number or `null` (rendered as an empty string). Objects, arrays, `undefined`, `NaN` and infinities fail the whole binding pass before any DOM change. The client writes `textContent`, never HTML, so markup in state is displayed literally.

The target must be text-only: an element with child elements, or an `input`, `textarea`, `select`, `script` or `style` element, is rejected. Form controls take their value from [`nv:model`](nv-model.md). The text reflects the local draft when an `nv:model` control has edited the same field, and an [`nv:optimistic`](nv-optimistic.md) projection while one is pending.

Bindings run after each mount, response and local draft change. Ignored subtrees, nested Live roots and island markers are skipped by their parent. `nv:text` can share a wrapper with [`nv:ignore.self`](nv-ignore.md).

## Server contract

The field is ordinary `@State()` (or `@Computed()`) public state; it does not have to be writable. Render the same value in the template so the first paint, crawlers and no-JavaScript visitors see it: the client only takes over afterwards. Every value in public state is sent to the browser, so never place secrets in a field just because no template displays it.

## Security

Writing `textContent` is not an HTML sink: state containing `<script>` or entity text stays inert. Under strict CSP and Trusted Types the binding needs no policy. This is not a sanitizer for other directives or for server templates, which escape output themselves.

## Accessibility

Put live-region semantics on the element when an update should be announced (`role="status"` or `aria-live="polite"`); `nv:text` does not add them. Avoid binding text inside a focused control's label in a way that changes its accessible name on every keystroke.

## Example

<!-- snippet: examples/starter-live/views/board.hbs -->

```html
<p id="board-status" role="status" nv:text="status">{{status}}</p>
```

<!-- snippet: examples/views-tour/views/tour-panel.hbs -->

```html
<p>Toggles: <span id="tour-toggles" nv:text="toggles">{{toggles}}</span></p>
```

## Verification

[Binding parser and evaluation tests](../../tests/client-bindings.test.ts), [DOM binding tests](../../tests/client-bindings-dom.test.ts) (text-only targets, escaped text, atomic validation), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) (`nv:model` drafts reflected in text), the [CSP suite](../../tests/client-csp.test.ts) (escaped text under Trusted Types) and the real-server [counter suite](../../tests/browser/live.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
