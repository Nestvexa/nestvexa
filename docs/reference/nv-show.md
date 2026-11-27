# nv:show

Show or hide an owned element from one boolean public state value:

```hbs
<p nv:show='hasError' role='alert' hidden>{{error}}</p>
```

## Syntax and modifiers

The value is a public state field or a dotted path of at most eight identifier segments. There are no modifiers; expressions such as `!open` or `count > 0` are rejected. Expose a boolean `@Computed()` value instead of writing a condition in markup.

The resolved value must be a boolean. Any other type, including `null`, a string or a number, fails the whole binding pass before any DOM change. `true` removes `hidden` and sets `aria-hidden="false"`; `false` sets `hidden` and `aria-hidden="true"`. The element keeps its markup: `nv:show` toggles visibility, it does not remove content from the DOM.

`nv:show` cannot share an element with [`nv:dirty`](nv-dirty.md) or a visibility loading effect (`nv:loading`, `nv:loading.remove`), because both would own `hidden`. It cannot sit on an [`nv:ignore.self`](nv-ignore.md) wrapper. Visibility changes run through [`nv:transition`](nv-transition.md) stages when the element declares them.

## Server contract

The field is ordinary `@State()` or `@Computed()` public state; it does not have to be writable. Render the initial `hidden` attribute in the template from the same value so the first paint is correct before the client mounts. The value reflects a local `nv:model` draft or an `nv:optimistic` projection of the same field.

## Security

Hidden content is still delivered to the browser. Do not use `nv:show` to protect data or controls: anything the user must not see should not be rendered, and any action behind a hidden button is still reachable by a forged request, so the server authorizes it.

## Accessibility

When an update hides the element that currently contains focus, the client first moves focus to the component root (adding a temporary `tabindex="-1"` when the root has none), so keyboard users are not left on a hidden control. See [focus restoration](../guides/focus-restoration.md#visibility-and-loading-ownership). Use `role="alert"` or `role="status"` on messages that should be announced when they appear, and keep `aria-controls`/`aria-expanded` on the toggle (for example with [`nv:bind`](nv-bind.md)).

## Example

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<button
  id="toggle"
  type="button"
  nv:click="toggle"
  nv:bind="aria-expanded:open"
  aria-controls="panel"
>
  Toggle panel
</button>
<div
  id="panel"
  nv:show="open"
  nv:transition.leave="fade"
  nv:transition.leave-end="faded"
>
  <button id="close" type="button" nv:click="toggle">Close panel</button>
</div>
```

<!-- snippet: examples/directive-lab/src/main.ts -->

```ts
  @Action() toggle(): void {
    this.open = !this.open;
  }
```

## Verification

[Binding tests](../../tests/client-bindings.test.ts), [DOM binding tests](../../tests/client-bindings-dom.test.ts) (boolean-only values, `hidden`/`aria-hidden`), [focus controller tests](../../tests/client-focus.test.ts), [presentation tests](../../tests/client-presentation.test.ts) (transitions), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) (focus moved before hiding focused content) and the real-server [visibility and focus scenarios](../../tests/browser/visibility-focus.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
