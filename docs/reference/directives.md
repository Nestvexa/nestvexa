# Live directives: current implementation

This alpha implements the following configuration grammar. Names identify registered actions or top-level public state. Expressions, dotted paths, executable JavaScript and unrecognized modifiers are rejected explicitly. The complete directive matrix in the master plan remains unmet.

| Directive                 | Current behavior                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `nv:click="increment"`    | Calls a registered action; disabled controls are ignored                                  |
| `nv:submit="save"`        | Prevents native submission and suppresses duplicate pending submits                       |
| `nv:keydown.enter="save"` | Calls a registered action when the selected keyboard event matches                        |
| `nv:model="name"`         | Holds text/number/checkbox edits and sends them with the next action                      |
| `nv:loading=""`           | Displays pending status and updates component `aria-busy`                                 |
| `nv:ignore=""`            | Preserves the subtree; put independently owned Alpine widgets here                        |
| `nv:text="name"`          | Sets primitive `textContent`; rejects targets containing elements or form controls        |
| `nv:show="visible"`       | Requires a boolean; toggles visibility/ARIA and moves focus before hiding focused content |
| `nv:bind="title:name"`    | Binds one allowed attribute to public state                                               |
| `nv:dirty="name"`         | Shows an indicator for pending local edits; empty value targets any field                 |
| `nv:cloak=""`             | Removed after successful initialization; add matching CSS to prevent initial flashing     |
| `nv:ref="name"`           | Declares a unique owned reference returned by `client.refs(element)`                      |

Attribute bindings allow `title`, `aria-label`, `aria-expanded`, `aria-disabled`, `href`, `src`, `disabled` and `readonly`. Boolean attributes require booleans. URLs accept HTTP(S) or relative URLs, rejecting credentials, whitespace/control characters and executable schemes. No style, event-handler, `srcdoc` or HTML binding exists.

## Event modifiers

The event slice accepts modifiers on `nv:click`, `nv:submit` and `nv:keydown`. Modifiers configure filtering and scheduling; their values never execute as JavaScript. An action value remains a registered identifier such as `save`, without parentheses or arguments.

| Modifier                                                          | Behavior                                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `.prevent`                                                        | Calls `preventDefault()` after event filters accept the event                                                                            |
| `.stop`                                                           | Uses a direct listener to stop propagation before native ancestor listeners; same-element listeners still follow normal browser ordering |
| `.self`                                                           | Accepts only events whose target is the directive element                                                                                |
| `.once`                                                           | Invokes once per element and canonical directive/action configuration                                                                    |
| `.ctrl`, `.alt`, `.shift`, `.meta`                                | Require those system keys; other pressed modifier keys are allowed                                                                       |
| `.enter`, `.escape`, `.space`, `.tab`, `.arrow-up`, `.arrow-down` | Select one key on `nv:keydown` only                                                                                                      |
| `.debounce.300ms`                                                 | Resets a trailing timer for each accepted event; invokes after the interval without a newer event                                        |
| `.throttle.500ms`                                                 | Invokes immediately, then suppresses events within the interval; no trailing invocation                                                  |

Bare `.debounce` and `.throttle` use 250ms. Explicit durations are whole milliseconds from 1 through 60,000, immediately following the scheduler modifier. Duplicate modifiers, multiple key filters, mixed debounce/throttle, unknown names, `.window` and `.document` fail explicitly. These event scheduler modifiers do not enable `nv:model` modifiers.

Event type, disabled controls, `.self`, key and required system-key filters run before modifier prevention or propagation changes. Owned Live forms are the exception: their native submission is always prevented, including when `.once`, throttling or duplicate-submit handling suppresses the action. This keeps an enhanced form from unexpectedly navigating away. `.once` is consumed when invocation is attempted, including a failed attempt; debounced `.once` events may reschedule until the timer fires. This prevents automatic retries of an action that may already have produced an effect.

Timers are canceled when their element detaches, leaves the client root, changes owning Live component, changes the action attribute, or the client is disposed. Direct `.stop` listeners are synchronized with owned directive elements and removed on disposal or removal. Each client dispatcher limits retained modifier configurations to 1,000 and rejects capacity overflow; direct listener bindings have the same bound. Only the action identifier and validated Live state/input go to the server; browser event objects are not serialized.

```html
<button type="button" nv:click.once="increment">Increase once</button>
<input aria-label="Search" nv:keydown.enter.prevent.debounce.300ms="search" />
<button type="button" nv:click.ctrl.throttle.500ms="refresh">Refresh</button>
```

The [event parser/dispatcher](../../packages/client/src/events.ts), [direct listener registry](../../packages/client/src/listeners.ts), [unit tests](../../tests/client-events.test.ts), [event browser scenarios](../../tests/browser/events.spec.ts) and [client lifecycle regressions](../../tests/client-lifecycle.test.ts) define this slice. All four event scenarios passed in Chromium, Firefox and WebKit as part of the 36-check event checkpoint; the aggregate suite passed 235 tests on Windows/Node 24 and subsequently on Node 22. These fixtures do not establish the complete modifier combination matrix. See [current implementation status](../implementation/STATUS.md) for exact scope and remaining gates.

```html
<label for="name">Name</label>
<input id="name" nv:model="name" />
<p nv:text="name" nv:bind="title:name"></p>
<span nv:dirty="name" hidden>Unsaved name</span>
```

Live owns component markup. Ignored subtrees, nested live roots and island markers have separate ownership. Public state is client-safe JSON. Templates and Alpine expressions are trusted application code; this is not a general HTML sanitizer. Update fragments currently accept HTML only; SVG/MathML and active document tags are rejected. Streaming, navigation, polling, sorting, transitions and model modifiers remain required implementation work.

See the [counter](../../examples/live-counter/README.md), [browser tests](../../tests/browser/live.spec.ts) and [binding tests](../../tests/client-bindings.test.ts). Keyboard/axe checks cover these fixtures only, without a general accessibility certification.
