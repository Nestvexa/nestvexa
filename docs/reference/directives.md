# Live directives: current implementation

This alpha implements the following configuration grammar. Names identify registered actions or top-level public state. Expressions, dotted paths, executable JavaScript and unrecognized modifiers are rejected explicitly. The complete directive matrix in the master plan remains unmet.

| Directive                 | Current behavior                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `nv:click="increment"`    | Calls a registered action; disabled controls are ignored                                   |
| `nv:submit="save"`        | Prevents native submission and suppresses duplicate pending submits                        |
| `nv:keydown.enter="save"` | Calls a registered action when the selected keyboard event matches                         |
| `nv:model="name"`         | Holds native form-control edits until an action; explicit modifiers enable synchronization |
| `nv:loading=""`           | Displays pending status and updates component `aria-busy`                                  |
| `nv:ignore=""`            | Preserves the subtree; put independently owned Alpine widgets here                         |
| `nv:text="name"`          | Sets primitive `textContent`; rejects targets containing elements or form controls         |
| `nv:show="visible"`       | Requires a boolean; toggles visibility/ARIA and moves focus before hiding focused content  |
| `nv:bind="title:name"`    | Binds one allowed attribute to public state                                                |
| `nv:dirty="name"`         | Shows an indicator for pending local edits; empty value targets any field                  |
| `nv:cloak=""`             | Removed after successful initialization; add matching CSS to prevent initial flashing      |
| `nv:ref="name"`           | Declares a unique owned reference returned by `client.refs(element)`                       |

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

Bare `.debounce` and `.throttle` use 250ms. Explicit durations are whole milliseconds from 1 through 60,000, immediately following the scheduler modifier. Duplicate modifiers, multiple key filters, mixed debounce/throttle, unknown names, `.window` and `.document` fail explicitly. Models have their own grammar described below.

Event type, disabled controls, `.self`, key and required system-key filters run before modifier prevention or propagation changes. Owned Live forms are the exception: their native submission is always prevented, including when `.once`, throttling or duplicate-submit handling suppresses the action. This keeps an enhanced form from unexpectedly navigating away. `.once` is consumed when invocation is attempted, including a failed attempt; debounced `.once` events may reschedule until the timer fires. This prevents automatic retries of an action that may already have produced an effect.

Timers are canceled when their element detaches, leaves the client root, changes owning Live component, changes the action attribute, or the client is disposed. Direct `.stop` listeners are synchronized with owned directive elements and removed on disposal or removal. Each client dispatcher limits retained modifier configurations to 1,000 and rejects capacity overflow; direct listener bindings have the same bound. Only the action identifier and validated Live state/input go to the server; browser event objects are not serialized.

```html
<button type="button" nv:click.once="increment">Increase once</button>
<input aria-label="Search" nv:keydown.enter.prevent.debounce.300ms="search" />
<button type="button" nv:click.ctrl.throttle.500ms="refresh">Refresh</button>
```

The [event parser/dispatcher](../../packages/client/src/events.ts), [direct listener registry](../../packages/client/src/listeners.ts), [unit tests](../../tests/client-events.test.ts), [event browser scenarios](../../tests/browser/events.spec.ts) and [client lifecycle regressions](../../tests/client-lifecycle.test.ts) define this slice. These fixtures do not establish the complete modifier combination matrix. See [current implementation status](../implementation/STATUS.md) for recorded validation and remaining gates.

## Model modifiers

Each native control accepts one `nv:model` declaration naming a top-level public state field. The field must also be writable on the server. Without a synchronization modifier, edits remain local until the next action sends the component's pending updates.

| Modifier                | Behavior                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| no modifier or `.defer` | Keeps local edits until an action; sends no independent synchronization request                                      |
| `.live`                 | Synchronizes input after a trailing 150ms debounce                                                                   |
| `.blur`                 | Synchronizes on the control's bubbling `focusout` event                                                              |
| `.change`, `.lazy`      | Synchronizes on native `change`; `.lazy` is an alias                                                                 |
| `.debounce.300ms`       | Uses a trailing debounce; implies `.live` when no mode is present                                                    |
| `.throttle.500ms`       | Sends immediately and suppresses calls within the interval; no trailing call                                         |
| `.number`               | Converts a complete finite decimal value, including exponent notation; rejects empty, hexadecimal and partial values |
| `.boolean`              | Accepts booleans or explicit `true`, `false`, `1`, `0` values; strings are trimmed and case-sensitive                |

Bare model `.debounce` and `.throttle` use 250ms. An explicit duration must be a whole number from 1 through 60,000 followed by `ms`. A model has at most one mode, one cast and one timer. Timing may be combined with `.live`, but is rejected with `.defer`, `.blur`, `.change` or `.lazy`. Duplicate, unknown, conflicting and event-only modifiers fail explicitly. Directive strings are configuration; no expression evaluation occurs.

Supported native HTML controls are text-like inputs (`text`, `email`, `search`, `tel`, `url`, `password`), numbers, checkboxes, radios, textareas and single selects. Number inputs use numeric conversion automatically. Checkboxes produce booleans and reject `.number`; unchecked radios produce no update. Ordinary text/select/radio values stay strings without a cast. Multiple selects, file models, arrays of checkbox selections, dotted paths and object-model editors are not implemented. Browser constraints do not replace server validation.

IME composition does not schedule intermediate input. After composition ends, the final input follows its model mode. Invalid local conversion reports an error and blocks component requests until corrected or the invalid control is removed; invalid numbers are never coerced to zero or submitted as a prior valid value. Requests are serialized with normal component revision checks. An ordinary action consumes pending updates and cancels outstanding model timers. Throttle intentionally has no eventual trailing synchronization; a subsequent accepted edit or action must send any remaining local value.

Model timers are bounded and canceled when the element detaches, leaves its client root, changes component ownership or model configuration, or the client is disposed. Model synchronization uses the generated `POST <endpoint>/<component>/_sync` route. The host must explicitly authorize the policy action `$sync`; it receives the same origin, CSRF, identity, ownership, size/rate and revision checks as actions. Component/global Nest guards, interceptors and filters apply. No action method or its method-level guard/pipe/interceptor/filter metadata is selected for a synchronization request. Place policies required for every write at the component/global level or in `authorize`.

```html
<label for="search">Search</label>
<input id="search" nv:model.live.debounce.300ms="query" />
<label for="quantity">Quantity</label>
<input id="quantity" type="number" nv:model.blur.number="quantity" />
<label for="enabled">Enabled</label>
<select id="enabled" nv:model.change.boolean="enabled">
  <option value="true">Yes</option>
  <option value="false">No</option>
</select>
```

The [model grammar/readers](../../packages/client/src/models.ts), [timing scheduler](../../packages/client/src/model-scheduler.ts), [grammar/native-control tests](../../tests/client-models.test.ts), [scheduler tests](../../tests/client-model-scheduler.test.ts), [server synchronization tests](../../tests/live-model.test.ts) and [browser model scenarios](../../tests/browser/models.spec.ts) define this slice. Consult the implementation checkpoint for executed integration and browser evidence; this reference does not mark the complete master-plan directive matrix accepted.

```html
<label for="name">Name</label>
<input id="name" nv:model="name" />
<p nv:text="name" nv:bind="title:name"></p>
<span nv:dirty="name" hidden>Unsaved name</span>
```

Live owns component markup. Ignored subtrees, nested live roots and island markers have separate ownership. Public state is client-safe JSON. Templates and Alpine expressions are trusted application code; this is not a general HTML sanitizer. Update fragments currently accept HTML only; SVG/MathML and active document tags are rejected. Streaming, navigation, polling, sorting, transitions and the wider model/form feature set remain required implementation work.

See the [counter](../../examples/live-counter/README.md), [browser tests](../../tests/browser/live.spec.ts) and [binding tests](../../tests/client-bindings.test.ts). Keyboard/axe checks cover these fixtures only, without a general accessibility certification.
