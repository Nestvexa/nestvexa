# nv:class

Toggle CSS class tokens on an owned element from boolean public state. This is the styling channel that works under a strict `style-src 'self'` policy:

```hbs
<p class='card' nv:class='is-urgent:urgent is-archived:archived'>Status</p>
```

## Syntax and modifiers

The value is 1 through 16 whitespace-separated `token:field` pairs. Each token matches `/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/` and must be unique on the element; each field is a public state field or a dotted path of at most eight segments (`done:task.done`). There are no modifiers, no expressions and no utility syntax containing punctuation (`md:flex`, `w-1/2`).

Every field must resolve to a boolean. The client calls `classList.toggle(token, value)` only for the listed tokens, so classes rendered by the server and not listed stay untouched. All pairs are validated before any change: one non-boolean value fails the whole pass and no class is toggled. `nv:class` never writes the `style` attribute.

A token cannot also be owned by another class effect on the same element: `nv:loading.class`, `nv:offline.class`, `nv:current` or a transition stage naming the same token is rejected. `nv:ignore.self` wrappers cannot carry `nv:class`.

## Server contract

The fields are ordinary `@State()` or `@Computed()` booleans. Render the initial classes in the template from the same state so the first paint matches; the client only toggles them afterwards. Class names are presentation, not authorization.

## Security

Only class membership changes, so a strict CSP without `'unsafe-inline'` for styles stays intact and state cannot inject `url()` requests or overlay content. Arbitrary style and property binding is intentionally not supported; see the [directive reference](directives.md).

## Accessibility

Do not convey state with color or a class alone: pair a visual class with text or an ARIA state (`aria-pressed`, `aria-expanded` via [`nv:bind`](nv-bind.md), or a visible label). Check contrast for every class combination, including forced-colors mode.

## Example

<!-- snippet: examples/views-tour/views/tour-panel.hbs -->

```html
<p
  id="tour-status"
  class="tour-status{{#if urgent}} is-urgent{{/if}}{{#if archived}} is-archived{{/if}}"
  nv:class="is-urgent:urgent is-archived:archived"
>
  Status card
</p>
```

<!-- snippet: examples/views-tour/src/main.ts -->

```ts
class TourPanel {
  @State() urgent = false;
  @State() archived = false;
  @State() toggles = 0;
  @Action() toggleUrgent(): void {
    this.urgent = !this.urgent;
    this.toggles++;
  }
```

## Verification

[Binding parser tests](../../tests/client-bindings.test.ts) (pair grammar, token rules, uniqueness, limits), [DOM binding tests](../../tests/client-bindings-dom.test.ts) (toggling only listed tokens, retained server classes, boolean-only values, conflicts with other class owners) and the real-server [views tour browser scenarios](../../tests/browser/views-tour.spec.ts).
