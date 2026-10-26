# Live directives: current implementation

This alpha implements the following configuration grammar. Names identify registered actions or top-level public state. Expressions, dotted paths, executable JavaScript and all modifiers are rejected explicitly. The complete directive matrix in the master plan remains unmet.

| Directive              | Current behavior                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `nv:click="increment"` | Calls a registered action; disabled controls are ignored                                  |
| `nv:submit="save"`     | Prevents native submission and suppresses duplicate pending submits                       |
| `nv:model="name"`      | Holds text/number/checkbox edits and sends them with the next action                      |
| `nv:loading=""`        | Displays pending status and updates component `aria-busy`                                 |
| `nv:ignore=""`         | Preserves the subtree; put independently owned Alpine widgets here                        |
| `nv:text="name"`       | Sets primitive `textContent`; rejects targets containing elements or form controls        |
| `nv:show="visible"`    | Requires a boolean; toggles visibility/ARIA and moves focus before hiding focused content |
| `nv:bind="title:name"` | Binds one allowed attribute to public state                                               |
| `nv:dirty="name"`      | Shows an indicator for pending local edits; empty value targets any field                 |
| `nv:cloak=""`          | Removed after successful initialization; add matching CSS to prevent initial flashing     |
| `nv:ref="name"`        | Declares a unique owned reference returned by `client.refs(element)`                      |

Attribute bindings allow `title`, `aria-label`, `aria-expanded`, `aria-disabled`, `href`, `src`, `disabled` and `readonly`. Boolean attributes require booleans. URLs accept HTTP(S) or relative URLs, rejecting credentials, whitespace/control characters and executable schemes. No style, event-handler, `srcdoc` or HTML binding exists.

```html
<label for="name">Name</label>
<input id="name" nv:model="name" />
<p nv:text="name" nv:bind="title:name"></p>
<span nv:dirty="name" hidden>Unsaved name</span>
```

Live owns component markup. Ignored subtrees, nested live roots and island markers have separate ownership. Public state is client-safe JSON. Templates and Alpine expressions are trusted application code; this is not a general HTML sanitizer. Update fragments currently accept HTML only; SVG/MathML and active document tags are rejected. Streaming, navigation, polling, sorting, transitions and model modifiers remain required implementation work.

See the [counter](../../examples/live-counter/README.md), [browser tests](../../tests/browser/live.spec.ts) and [binding tests](../../tests/client-bindings.test.ts). Keyboard/axe checks cover these fixtures only, without a general accessibility certification.
