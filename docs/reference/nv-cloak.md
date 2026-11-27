# nv:cloak

Hide interactive markup until the Live client has initialized it:

```css
[nv\:cloak] {
  display: none !important;
}
```

## Syntax and modifiers

`nv:cloak=""` takes an empty value (a bare `nv:cloak` attribute is the same). Any other value or modifier is a `DIRECTIVE` error.

The attribute has no effect by itself: the page stylesheet hides it. After the first binding pass of the owning component succeeds, the client removes `nv:cloak` from every owned element, so the CSS rule stops matching. If any binding in that pass fails validation, nothing is applied and the cloak stays, so half-initialized content never appears. Cloaks inside ignored subtrees, nested Live roots and islands belong to their own owners. `nv:cloak` cannot sit on an `nv:ignore.self` wrapper.

## Server contract

None. The server renders the cloaked markup like any other; the directive is presentation only.

## Security

Cloaked content is delivered in the HTML and visible in source or with styles disabled. Do not cloak anything the user is not allowed to see. Ship the rule in a stylesheet rather than a `style` attribute so a strict `style-src` policy keeps working ([CSP guide](../guides/csp.md)).

## Accessibility and fallback

Without JavaScript the cloak is never removed, so cloaked content stays hidden for those visitors. Cloak only the parts that do not work without the client, and give a `<noscript>` alternative or an ordinary link or form for the rest. `display: none` also hides content from assistive technology until initialization, which is the intent.

## Example

<!-- snippet: examples/views-tour/views/tour-panel.hbs -->

```html
<div id="tour-cloaked" nv:cloak="">
  <p
    id="tour-status"
    class="tour-status{{#if urgent}} is-urgent{{/if}}{{#if archived}} is-archived{{/if}}"
    nv:class="is-urgent:urgent is-archived:archived"
  >
    Status card
  </p>
  <p>Toggles: <span id="tour-toggles" nv:text="toggles">{{toggles}}</span></p>
  <button type="button" id="toggle-urgent" nv:click="toggleUrgent">
    Toggle urgent
  </button>
  <button type="button" id="toggle-archived" nv:click="toggleArchived">
    Toggle archived
  </button>
</div>
```

<!-- snippet: examples/views-tour/src/main.ts -->

```ts
      // Ship this rule with every page that uses nv:cloak.
      '[nv\\:cloak]{display:none!important}',
```

The panel also renders `<noscript><p>The interactive panel needs JavaScript.</p></noscript>`.

## Verification

[Binding tests](../../tests/client-bindings.test.ts) and [DOM binding tests](../../tests/client-bindings-dom.test.ts) (empty value, removal only after successful validation), the [CSP suite](../../tests/client-csp.test.ts) (cloak removal without a policy violation), the [grammar matrix](../../tests/client-directive-grammar.test.ts) and the real-server [counter suite](../../tests/browser/live.spec.ts) and [views tour](../../tests/browser/views-tour.spec.ts).
