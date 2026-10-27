# Native form reset and Live model drafts

A native reset restores browser controls to their current defaults. Nestvexa also reconciles the reset controls' owned `nv:model` fields, so a discarded draft is not retained in `client.get()` or sent by the next action. Resetting is a local operation: it does not call an action or automatically send `_sync`.

```hbs
<form nv:submit='save'>
  <label for='display-name'>Display name</label>
  <input id='display-name' nv:model='name' value='{{name}}' />
  <button type='submit'>Save</button>
  <button type='reset'>Discard local edits</button>
</form>
```

The component must still register writable `name` state and an authorized `save` action. Reset does not declare fields writable, skip validation or grant permission. See the [counter bootstrap](../../examples/live-counter/README.md).

## Invoke a real native reset

Use a reset button or the native `HTMLFormElement.reset()` method. Dispatching a synthetic `reset` event does not execute the browser's form-reset algorithm, and the client ignores that event. The trusted-event check selects native behavior; it is not an authentication or authorization boundary.

```js
const form = document.getElementById('profile-form');
if (form instanceof HTMLFormElement) {
  HTMLFormElement.prototype.reset.call(form);
}
```

Calling the prototype method also works when a form control named or identified as `reset` masks `form.reset`. The client uses the same native method on a detached prediction form; it does not execute reset expressions from HTML attributes.

## Defaults, timing and pending requests

The client observes native resets at document capture, then waits until reset-event dispatch has ended before reconciling actual control values. A host listener can cancel the reset with `preventDefault()`, including a later document listener. A canceled reset leaves the draft, validation state and pending model timers alone. Stopping event propagation does not itself cancel the native reset.

For a completed reset, the client reads actual native values and records a new local field version, even when a reset value equals the last server value. That version prevents an already pending action response from reinstating the discarded edit. A subsequent explicit action can send the reset value; no automatic rollback of an action already committed on the server occurs.

Reset clears local conversion errors and composition tracking for the reset model controls when their resulting values are representable. It cancels pending model timers for the affected public fields, including aliases elsewhere in the same component. It does not cancel an unrelated debounced action or other fields' model work. `get()`, `set()` and action dispatch reconcile a completed reset before accessing or sending state; a getter inside a reset listener cannot preempt a later cancellation.

Later input remains a new edit. Form controls, ownership and model configuration are checked again before reconciliation. A detached form, transferred control, changed model signature or disposed/remounted client cannot apply an old reset plan. The pending plan queue is bounded to 1,000 forms. One cancellable browser task also finishes reconciliation after native button event dispatch, where a microtask can run between listeners. Plans and the task are cleared on disposal.

## Actual form ownership and renderer boundaries

Reconciliation follows the native `form.elements` collection and each control's actual form owner, not merely descendants of the `<form>` node. It includes disabled model controls and explicitly associated controls outside the form. A form outside an element-scoped client root can reset an associated owned control inside that root.

Only active controls owned by that client registration are reconciled. Whole-ignore and island boundaries retain their ownership rules; unbound controls do not become Live state. Independent nested Live registrations keep their own field state. A native reset can still affect unbound or widget-owned controls according to browser rules, without exposing those values to the client or server.

A public field is shared within its component. Resetting one form's control changes that field's local draft and cancels its model timers; it does not physically reset another form's control merely because it names the same field. Use separate state fields for independent forms rather than relying on aliases as separate drafts.

## Rejected or changed defaults

Before allowing the native operation, the client predicts defaults on a detached native form. It cancels the reset and reports a `DIRECTIVE` error when the defaults cannot describe the supported primitive model state. This includes:

- An empty or otherwise invalid numeric model default.
- A model radio field with no selected default choice.
- Conflicting default values among controls sharing one public model field.
- A model radio group shared across client/renderer ownership boundaries.

These restrictions preserve the existing primitive-only model contract. They do not add nullable radio models, array-valued selects, files, nested field paths or a forms schema system. Correct the defaults or use the host's explicit form logic for unsupported state.

Trusted host code can change defaults during reset-event dispatch. If a resulting model becomes unrepresentable after the native reset has run, the client suspends that component's transport instead of dispatching stale hidden state. Recover through authoritative reconciliation as described in the [request lifecycle guide](request-lifecycle.md). A client already suspended by an uncertain request does not regain transport permission merely because its form was reset.

## Scope and evidence

Native reset follows the [HTML form reset algorithm](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#resetting-a-form), rechecked October 27, 2026. Prediction, field versioning, timer cancellation and the restrictions above are Nestvexa policy layered over that behavior.

Implementation is in [form-reset](../../packages/client/src/form-reset.ts) and the [client runtime](../../packages/client/src/index.ts). The [controlled Chromium cases](../../tests/client-form-reset.test.ts) cover client behavior rather than Nest conformance. The [real Nest browser scenarios](../../tests/browser/form-reset.spec.ts) cover discarded drafts, canceled resets, queued synchronization and in-flight action responses. Consult [implementation status](../implementation/STATUS.md) for executed results and package/runtime evidence.

This slice does not implement the complete forms package, wizard state, DTO/Zod validation, automatic no-JavaScript submission fallback or the full input/accessibility/renderer matrix. Server validation, CSRF/origin checks, writable-state allowlists, identity and authorization remain authoritative.
