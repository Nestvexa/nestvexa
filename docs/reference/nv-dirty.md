# nv:dirty

Show an indicator while a Live component holds local edits the server has not accepted yet:

```hbs
<span nv:dirty='title' hidden>Unsaved title</span>
<span nv:dirty='' hidden>Unsaved changes</span>
```

## Syntax and modifiers

`nv:dirty="field"` names a public state field or a dotted path of at most eight segments; `nv:dirty=""` tracks every field of the component. There are no modifiers.

The indicator is shown (`hidden` removed, `aria-hidden="false"`) while a local [`nv:model`](nv-model.md) draft (or a `client.set()` value) for the field differs from the server value, or while a control for it holds an invalid local conversion such as a partial number. A field indicator also reflects drafts of its nested paths: `nv:dirty="address"` is shown for an edited `address.city`. It hides again when a response accepts the value or when the user restores the server value. Values the browser restored before mount count as drafts ([restored drafts](../guides/nested-models.md#restored-drafts)), and a native form reset reconciles them ([form reset](../guides/form-reset.md)).

`nv:dirty` owns `hidden`, so it cannot share an element with [`nv:show`](nv-show.md) or a visibility loading effect, and it cannot sit on an `nv:ignore.self` wrapper.

## Server contract

Nothing extra: dirtiness is local client state compared with the last authoritative server state. The field still has to be writable (`@State({ writable: true, validate })`) for the draft to be accepted when an action or `$sync` request sends it; a rejected update leaves it dirty.

## Security

The indicator only reflects browser state; it does not save anything or prove what the server stored. Never rely on it for conflict detection between users.

## Accessibility

Render it `hidden` in server markup. Use visible text ("Unsaved title") rather than a color dot, and add `role="status"` when its appearance should be announced. If focus is inside the indicator when it hides, focus moves to the component root as with `nv:show`.

## Example

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<span id="email-dirty" nv:dirty="email" hidden>Unsaved email</span>
```

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<span id="address-dirty" nv:dirty="address" hidden>Unsaved address</span>
```

## Verification

[Binding tests](../../tests/client-bindings.test.ts), [DOM binding tests](../../tests/client-bindings-dom.test.ts), [form reset tests](../../tests/client-form-reset.test.ts), [runtime resilience rows](../../tests/client-runtime-resilience.test.ts), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) (field and any-field indicators, cleared by server agreement and by restoring the value, nested-path drafts, restored drafts) and the real-server [directive lab](../../tests/browser/directive-lab.spec.ts) and [counter suite](../../tests/browser/live.spec.ts).
