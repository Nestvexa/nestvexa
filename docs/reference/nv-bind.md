# nv:bind

Bind one allowlisted attribute of an owned element to public state:

```hbs
<a nv:bind='href:healthLink' href='/api/health'>Native health endpoint</a>
```

## Syntax and modifiers

The value is `attribute:field`, exactly one pair. The field is a public state field or a dotted path of at most eight identifier segments. There are no modifiers and no expressions; to bind two attributes, use two elements or render the second attribute on the server.

| Attribute                        | Accepted value                            | Effect                                    |
| -------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `title`, `aria-label`            | string, boolean, finite number or `null`  | Set as text; `null` removes the attribute |
| `aria-expanded`, `aria-disabled` | boolean                                   | Set to `"true"`/`"false"`                 |
| `disabled`, `readonly`           | boolean                                   | Toggle the boolean attribute              |
| `href`, `src`                    | relative or HTTP(S) URL string, or `null` | Set the attribute; `null` removes it      |

URLs are resolved against the document base. Credentials (`https://user@host`), whitespace or control characters and every non-HTTP(S) scheme (`javascript:`, `data:`, `blob:`, `file:`) are rejected. Any invalid value fails the whole binding pass before the DOM changes.

No other attribute or property is bindable: there is no `style`, `class` (use [`nv:class`](nv-class.md)), `value`/`checked` (use [`nv:model`](nv-model.md)), `on*`, `srcdoc` or HTML binding. A loading effect for the same attribute on the same element is rejected, and `nv:bind` cannot sit on an [`nv:ignore.self`](nv-ignore.md) wrapper.

## Server contract

The field is ordinary `@State()` or `@Computed()` public state, read-only unless you also model it. Render the same attribute in the template for the first paint. Binding `disabled` on a control does not stop a forged action: the server still authorizes and validates it.

## Security

The allowlist exists because attributes are script and request sinks. URL validation prevents state from turning a link into `javascript:` navigation or a credential-bearing request; it does not decide whether a same-origin path is appropriate for the user, so the server should only put allowed destinations in state.

## Accessibility

`aria-expanded` with `aria-controls` keeps a disclosure toggle in step with an [`nv:show`](nv-show.md) panel. Prefer `aria-disabled` to `disabled` when a control must stay focusable while unavailable. `title` is not a substitute for a visible label.

## Example

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<p id="name-preview" nv:text="name" nv:bind="title:name" nv:cloak="">
  {{name}}
</p>
```

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
```

## Verification

[Binding parser and URL validation tests](../../tests/client-bindings.test.ts), [DOM binding tests](../../tests/client-bindings-dom.test.ts) (allowlist, boolean attributes, rejected schemes and credentials, atomic validation), [loading conflict tests](../../tests/client-loading.test.ts), [presentation conflict tests](../../tests/client-presentation.test.ts), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) and the real-server [counter suite](../../tests/browser/live.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
