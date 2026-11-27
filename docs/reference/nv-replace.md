# nv:replace

Opt a subtree out of keyed morphing so each response replaces it outright:

```hbs
<p nv:replace>Server item count: {{rows.length}}</p>
<input nv:replace.self type='file' aria-label='Resetting attachment' />
```

## Syntax and modifiers

| Declaration          | Behavior                                                                           |
| -------------------- | ---------------------------------------------------------------------------------- |
| `nv:replace=""`      | Replace every child; keep the wrapper object and reconcile its attributes normally |
| `nv:replace.self=""` | Replace the whole element                                                          |

Both take an empty value and cannot coexist on one node. The incoming server fragment decides: if it declares replacement the subtree is replaced, otherwise it is morphed as usual, so a previous declaration does not lock future responses into replacement.

Neither form is allowed on the Live component root or on the same node as `nv:ignore`, a nested Live root or an island marker. Void elements and native `input`/`textarea`/`select` controls require `.self`; child replacement needs a container. An `nv:ignore.self` wrapper cannot carry either form.

## What replacement resets

Replacement deliberately discards node-local state in the removed subtree: event listeners and widget state, native input values and file selections, Alpine local state, and nested ignored, island or Live boundaries inside it (framework owners must handle teardown). When every original `nv:model` control for a dirty field is removed, its local draft is discarded and the new server state wins. Removing the focused control moves focus to the retained component root.

Before each removed outer element goes, the client cancels its scheduled event and model work, removes direct listeners, aborts requests of nested mounted Live roots and emits a bubbling, non-cancelable `nestvexa:before-remove` on it; each inserted outer element emits `nestvexa:after-insert`. These lifecycle details are in the [directive reference](directives.md#explicit-replacement-and-removal-lifecycle).

## Server contract

None beyond rendering: the template chooses replacement per fragment. Use it for content whose identity changes completely (a regenerated chart, a reset file input), not for forms the user is editing.

## Security

Replacement applies the same validated server fragment as morphing; it adds no HTML sink and no new capability. Active document tags, SVG/MathML and malformed fragments are rejected either way.

## Accessibility

Replacing a subtree that contains focus moves focus to the component root, which screen-reader users notice. Keep focusable controls the user is likely to be using outside replaced regions, and announce significant replacements with a status message.

## Example

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<section id="replace-children" nv:replace="" aria-label="Replace children">
  <h2>Replacement children</h2>
  <label for="replacement-note">Temporary replacement note</label
  ><input id="replacement-note" value="Server default" />
  <button type="button" nv:click="increment">Replace children increase</button>
  <output>{{count}}</output>
</section>
<section id="replace-self" nv:replace.self="" aria-label="Replace element">
  <h2>Replacement element</h2>
  <button type="button" nv:click="increment">Replace element increase</button
  ><output>{{count}}</output>
</section>
```

## Verification

[Replacement tests](../../tests/client-replace.test.ts), [rendering lifecycle tests](../../tests/client-rendering-lifecycle.test.ts) (removal/insertion events, focus, nested roots), [native control tests](../../tests/client-native-controls.test.ts), [form reset tests](../../tests/client-form-reset.test.ts), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) and the real-server [replacement and loading scenarios](../../tests/browser/replacement-loading.spec.ts).
