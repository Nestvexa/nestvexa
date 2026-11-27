# nv:ignore and nv:ignore.self

Hand a subtree, or only a wrapper's attributes, to code other than Live reconciliation:

```hbs
<aside nv:ignore x-data='{ clicks: 0 }' aria-label='Local notes'>…</aside>
<section nv:ignore.self class='widget'>…live children…</section>
```

## Syntax and modifiers

| Declaration         | Ownership                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `nv:ignore=""`      | The whole subtree is retained as is; Live never patches it or its descendants                         |
| `nv:ignore.self=""` | The wrapper's attributes (class, style, ARIA, IDs) are retained; its children are reconciled as usual |

Both require one empty declaration. Unknown modifiers, a value, or whole and self ignore together are rejected. Root `nv:ignore` on the Live component is invalid, but an independent Live root under an ignored ancestor is allowed and owns itself.

**Whole ignore.** Directives inside the subtree are not discovered by the parent component: no actions, models, bindings, loading, observers or refs run there. Put independently owned Alpine widgets (`x-data`) and third-party editors here; Alpine's `$live` bridge requires a whole-ignore boundary. An ignored node stays opaque during ordinary reconciliation until a key change or an ancestor replacement removes it.

**Wrapper ignore.** Child actions, models, text, loading and refs stay active, and same-node `nv:click`/`nv:text`/`nv:ref` keep their contracts. Effects that would write the wrapper's attributes cannot share it: `nv:bind`, `nv:show`, `nv:dirty`, `nv:cloak`, `nv:class`, `nv:model`, loading/target and replacement directives. `input`, `textarea`, `select`, `option`, `optgroup`, editable wrappers, Live roots and island roots reject `.self`; use whole ignore for an independently owned native control. Retained wrapper `nv:*` declarations must stay identical between responses, and switching between ordinary, self and whole ignore replaces the element. Full rules are in the [wrapper ownership guide](../guides/ignore-self.md).

## Server contract

None. The server keeps rendering the subtree (it is the initial HTML), but later responses do not overwrite ignored content. State the ignored widget needs must reach it another way, for example through Alpine's `$live` helper.

## Security

Ignoring a subtree moves ownership, not trust: the content is still the page's own markup and scripts. Server state shown inside an ignored region may become stale, so do not display authorization-sensitive values there. Ignore does not change what actions the server permits.

## Accessibility

Content inside an ignored region keeps whatever ARIA state its owner gives it; Live will not update labels or `aria-*` there. Make sure the owning widget manages its own focus and announcements.

## Example

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<section
  id="alpine-widget"
  nv:ignore=""
  x-data="localCounter"
  aria-label="Alpine local widget"
>
  <h2>Alpine local widget</h2>
  <button type="button" x-on:click="incrementLocal">Local Alpine click</button>
  <output id="alpine-local" x-text="clicks">0</output>
  <button type="button" x-on:click="incrementServer">
    Alpine server increment
  </button>
  <button type="button" x-on:click="renameServer">Alpine save name</button>
  <p>
    Server count from Alpine:
    <span id="alpine-server" x-text="$live.get('count')">0</span>
  </p>
</section>
```

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<section
  id="self-widget"
  nv:ignore.self=""
  class="server-wrapper-{{count}}"
  data-server-count="{{count}}"
  aria-label="Widget wrapper with live children"
>
  {{> self-widget-body}}
</section>
```

## Verification

[Wrapper ownership tests](../../tests/client-ignore-self.test.ts), [ownership transition tests](../../tests/client-ownership-transitions.test.ts), [rendering lifecycle tests](../../tests/client-rendering-lifecycle.test.ts), [Alpine bridge tests](../../tests/alpine-start.test.ts), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) and the real-server [wrapper scenarios](../../tests/browser/ignore-self.spec.ts), [Alpine bridge scenarios](../../tests/browser/alpine-bridge.spec.ts) and [counter suite](../../tests/browser/live.spec.ts).
