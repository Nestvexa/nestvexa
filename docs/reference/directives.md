# Live directives: current implementation

This alpha implements the following configuration grammar. Names identify registered actions or top-level public state. Expressions, dotted paths, executable JavaScript and unrecognized modifiers are rejected explicitly. The complete directive matrix in the master plan remains unmet.

| Directive                 | Current behavior                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `nv:click="increment"`    | Calls a registered action; disabled controls are ignored                                       |
| `nv:submit="save"`        | Prevents native submission and suppresses duplicate pending submits                            |
| `nv:keydown.enter="save"` | Calls a registered action when the selected keyboard event matches                             |
| `nv:model="name"`         | Holds native form-control edits until an action; explicit modifiers enable synchronization     |
| `nv:loading=""`           | Displays pending status; optional targets/classes/allowlisted attributes track queued requests |
| `nv:target="save,$sync"`  | Selects 1–16 action/synchronization identifiers for loading directives on the same element     |
| `nv:replace=""`           | Replaces children of an owned inner wrapper; `.self` replaces the wrapper too                  |
| `nv:ignore=""`            | Preserves the subtree; put independently owned Alpine widgets here                             |
| `nv:ignore.self=""`       | Retains an inner wrapper's attributes while descendants remain Live-owned                      |
| `nv:text="name"`          | Sets primitive `textContent`; rejects targets containing elements or form controls             |
| `nv:show="visible"`       | Requires a boolean; toggles visibility/ARIA and moves focus before hiding focused content      |
| `nv:bind="title:name"`    | Binds one allowed attribute to public state                                                    |
| `nv:dirty="name"`         | Shows an indicator for pending local edits; empty value targets any field                      |
| `nv:cloak=""`             | Removed after successful initialization; add matching CSS to prevent initial flashing          |
| `nv:ref="name"`           | Declares a unique owned reference returned by `client.refs(element)`                           |

Attribute bindings allow `title`, `aria-label`, `aria-expanded`, `aria-disabled`, `href`, `src`, `disabled` and `readonly`. Boolean attributes require booleans. URLs accept HTTP(S) or relative URLs, rejecting credentials, whitespace/control characters and executable schemes. No style, event-handler, `srcdoc` or HTML binding exists.

## Request deadlines and suspended transport

Directive actions and model synchronization share the [bounded request lifecycle](../guides/request-lifecycle.md). `createLiveClient({ requestTimeoutMs })` accepts an integer from 1 through 300,000, defaulting to 30,000ms. The dispatch-to-body deadline excludes queue wait; the streaming response limit is 2,097,152 bytes with JSON MIME and strict UTF-8 validation. No timeout or retry modifier is added to directive strings.

An uncertain transport/protocol/render failure suspends subsequent requests for the component and nested owned roots. Scheduled directive work is canceled, queued calls reject the stored cause, loading baselines restore and `aria-busy` becomes false. Local draft/state access remains available and `nv:submit` still prevents native submission; clicking again does not silently retry. Explicit correction remains possible after the documented HTTP rejection allowlist. A host must reload or reconcile authoritative state before disposal/remounting to resume uncertain work. Aborting or removing a component does not undo server effects, and cancellation resolving a client promise does not acknowledge business success.

## Whole subtree and wrapper-only ignore

`nv:ignore=""` retains a whole subtree. `nv:ignore.self=""` instead retains an inner wrapper's current attributes, including class/style/ARIA and IDs, while Live updates its children normally. Child actions, models, text, loading and refs remain active. Use a stable `data-nv-key` when the widget may change its wrapper ID. Same-node event/text/ref declarations retain their existing contracts, but all retained wrapper `nv:*` declarations must remain identical between responses. Reconfiguration requires a new key or explicit ancestor replacement and is rejected before patching owned HTML otherwise.

Self-ignore cannot share a node with `nv:bind`, `nv:show`, `nv:dirty`, `nv:cloak`, model, loading/target or replacement effects, including their modifiers. Put those effects on children. Input/textarea/select/option/optgroup elements, editable wrappers, Live roots and island roots reject self-ignore explicitly; use whole ignore for an independently owned native control or editor. Both ignore forms require one empty declaration, and unknown modifiers or simultaneous whole/self declarations are rejected.

Ordinary↔self transitions replace the element and clean up removed descendants. A self wrapper changing to a whole-ignore or renderer boundary also replaces it. An already whole-ignored node stays opaque during ordinary reconciliation until key/ancestor replacement. Retained self wrapper attributes are projected into effective incoming markup before preview validation and native form-owner capture. `.self` does not provide Alpine `$live` isolation, which still requires whole ignore, or change server authorization. See the [full wrapper ownership guide](../guides/ignore-self.md) and [real Nest browser scenarios](../../tests/browser/ignore-self.spec.ts).

## Loading and targets

Loading counts include queued and executing requests, so an effect stays active until its matching requests settle. Counts are isolated by Live component and action; the internal synchronization request is named `$sync` for targeting. There is no loading delay or duration modifier.

| Declaration                         | Behavior while matching work is pending                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `nv:loading=""`                     | Shows the element; otherwise hides it using `hidden` and `aria-hidden`                      |
| `nv:loading.remove=""`              | Hides the element; otherwise shows it                                                       |
| `nv:loading.class="working busy"`   | Adds each listed simple class                                                               |
| `nv:loading.class.remove="ready"`   | Removes each listed simple class                                                            |
| `nv:loading.attr="disabled"`        | Applies the selected boolean attribute, or `true` for an allowed ARIA attribute             |
| `nv:loading.attr.remove="readonly"` | Removes the selected attribute                                                              |
| `nv:target="save,$sync"`            | Activates same-element loading effects when any listed request has a positive pending count |

Without `nv:target`, any pending request on the component activates the element's loading effects. A target is a comma-separated list of 1 through 16 unique registered-style identifiers, with `$sync` explicitly allowed; empty, duplicate, executable or dotted expressions are rejected. Target names do not expose methods or grant permission. `nv:target` without a same-element loading directive is invalid.

Class declarations allow 1 through 16 unique whitespace-separated tokens, each starting with a letter/underscore and containing only letters, digits, underscore or hyphen, up to 64 characters. This deliberately excludes arbitrary class expressions and utility syntax containing punctuation. Attribute effects allow only `disabled`, `readonly`, `aria-disabled` and `aria-busy`. Native `disabled` requires a disableable HTML form control. `readonly` requires a textarea or a supported text/date/time/number input; checkbox, radio, file, hidden, range, color and button types are rejected because HTML ignores the attribute there. See the [HTML input attribute rules](https://html.spec.whatwg.org/multipage/input.html#attr-input-readonly). Attribute names and class tokens are configuration, never JavaScript.

Class effects restore token membership; attribute effects restore their exact captured values after work settles or the controller releases the element. Class attribute whitespace/order is not preserved. They do not blindly enable a control: an initially disabled server control stays disabled. Later host changes are retained as the next baseline, and baselines are restored before incoming server markup is applied. Visibility directives deliberately own `hidden`/`aria-hidden` while mounted; cleanup restores their captured values. Component `aria-busy` reflects all component requests independently of loading targets.

Multiple loading declarations may coexist only when they control distinct properties. Duplicate property owners, visibility combined with `nv:show`/`nv:dirty`, and loading plus `nv:bind` for the same attribute are rejected before applying the effects. Loading visibility cannot hide the component root, and loading cannot own root `aria-busy`. Hiding focused content moves focus to the retained root. Ignored, island and nested Live subtrees are not patched by their parent loading controller. Effects are restored on detach, reconfiguration, ownership change or client disposal. None of these UI states replaces server authorization or prevents a forged HTTP request.

```html
<button
  type="button"
  nv:click="save"
  nv:loading.attr="disabled"
  nv:target="save"
>
  Save
</button>
<span role="status" nv:loading="" nv:target="save,$sync" hidden>Updating…</span>
<span class="ready" nv:loading.class.remove="ready" nv:target="save"
  >Status</span
>
```

The [loading parser/controller](../../packages/client/src/loading.ts), [loading tests](../../tests/client-loading.test.ts) and [loading/replacement browser scenarios](../../tests/browser/replacement-loading.spec.ts) define this slice. Current execution evidence belongs in the implementation checkpoint; no complete concurrency/accessibility acceptance is inferred from file presence.

## Explicit replacement and removal lifecycle

`nv:replace=""` replaces every child of its owned inner container while retaining the wrapper object. Its wrapper attributes are still reconciled from the server fragment. `nv:replace.self=""` replaces the whole element. Both require empty values and cannot coexist on one node. The incoming server fragment chooses replacement versus normal keyed morphing; a previous replacement declaration does not force future fragments to keep that mode.

Neither form is allowed on the Live component root or on the same node as `nv:ignore`, a nested Live root or an island marker. Void elements and native input/textarea/select controls require `.self`; child replacement requires a container. Stable ignored/nested/island boundaries survive ordinary parent morphing, including keyed moves. An explicitly replaced ancestor deliberately removes its descendants, including ownership boundaries. Framework owners must handle teardown when that happens; this is not automatic React/Vue/Svelte island integration.

Replacement resets node-local event/widget state, native input/file selections and Alpine local state inside the removed subtree. It is unsuitable for edits that must survive reconciliation. When every original model control for a dirty field is removed, its local dirty value is discarded even if a newly inserted control names the same field; the new server state becomes authoritative. If an original matching control survives, the ordinary newer-edit preservation rule remains. Removing the focused control moves focus to the retained component root rather than attempting to focus a detached node.

Before each outer element subtree is removed, the client cancels its scheduled event/model work, removes direct listeners, aborts requests for nested mounted Live roots and releases their client ownership. It then emits bubbling, noncancelable `nestvexa:before-remove` on the still-connected outer element. After an outer element subtree is inserted, `nestvexa:after-insert` bubbles from that element. Descendants are covered by their outer notification; retained keyed moves do not emit remove/insert events. Text-node changes do not emit these DOM CustomEvents. The events carry no request/state payload and cannot cancel replacement. `nestvexa:updated` signals completion of Live reconciliation and client discovery, not completion of every third-party asynchronous initializer.

```html
<section nv:replace="" aria-label="Resetting panel">
  <label for="temporary">Temporary note</label>
  <input id="temporary" value="Server default" />
</section>
<input nv:replace.self="" type="file" aria-label="Resetting attachment" />
```

The [morph implementation](../../packages/client/src/morph.ts), [replacement tests](../../tests/client-replace.test.ts), [rendering lifecycle tests](../../tests/client-rendering-lifecycle.test.ts) and [browser scenarios](../../tests/browser/replacement-loading.spec.ts) define the current replacement boundary. Controlled transport fixtures in lifecycle tests do not establish server protocol conformance. The full nested component server API, official framework island mounts and all renderer-specific teardown contracts remain required work.

Ordinary morphing checks a retained control's selection capability after applying its new type before restoring a saved caret. A text-to-number/email/file change must still advance the client revision and permit the next action. The lifecycle regressions cover all three changes, and the Nest browser flow covers text/number switching. This does not accept the entire native-input matrix.

If a retained focused control becomes disabled, hidden, inert or unrendered, reconciliation attempts to move focus to an available component root. It preserves a different focus target chosen by synchronous host hooks and cleans up its temporary root tabindex on blur, release or disposal. See [focus restoration](../guides/focus-restoration.md) for boundaries, host ownership and verification scope.

## Native values and component ownership

Ordinary morphing preserves an unbound control's live value or selection while its incoming server default stays unchanged. A changed default replaces it. This includes unbound multiple selects; it does not enable array-valued `nv:model`. Textareas receive the new `defaultValue` for native form reset, and keyed options preserve selected identity when values repeat. Bound controls follow the response unless a compatible newer local draft exists. The field, conversion and native control type must still match an original surviving control; otherwise both the visible control and hidden dirty state reset from the server. A dirty radio choice that disappears leaves no matching radio checked rather than silently selecting a different choice.

File selections survive ordinary reconciliation on a retained file input and reset on explicit replacement. The client does not upload them automatically. `contenteditable=true` content remains local; `contenteditable=false` is patched normally. Unbound values are browser-local and never become public component state merely because the controls have a `name`. Valid form structure and distinct radio groups per owner are required: shared same-name native groups across Live/island owners are not a proven isolation boundary.

Registration records the raw `data-nv-component`, `data-nv-name`, `data-nv-endpoint`, `data-nv-csrf`, `data-nv-snapshot`, `data-nv-revision` and `data-nv-state` attributes. An external change invalidates the registration once and cancels/aborts its work until the host disposes and remounts it. Raw initial formatting and the client's own response writes are accepted; this check is not cryptography, authentication or authorization. Root `nv:ignore` is invalid, but an independent Live root under an ignored ancestor is permitted. Moving a root into an island releases it without emitting fake DOM-removal lifecycle events. See [native controls and ownership](../guides/native-controls.md) for examples and boundaries.

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

Native reset buttons and `HTMLFormElement.reset()` also reconcile the owned model drafts without adding an `nv:reset` directive. A completed reset records a new field version, cancels affected model timers and leaves synchronization to a later explicit edit/action; a canceled reset changes neither draft state nor timers. Synthetic reset-event dispatch is ignored because it does not run the native reset algorithm. Actual form ownership, renderer boundaries and representable defaults apply; invalid numeric defaults, unselected model-radio defaults, conflicting aliases and cross-owner radio groups reject the reset. See the [native reset guide](../guides/form-reset.md) for synchronous access, pending responses, external associated controls and limits.

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
