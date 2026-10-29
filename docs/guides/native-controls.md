# Native controls and DOM ownership

This guide describes the current client merge rules. It does not establish completion of the full native-input, framework, accessibility or browser matrix in the master plan. Ordinary reconciliation and explicit replacement have different state contracts.

## Browser values and server defaults

The client snapshots owned native controls before a patch can change radio groups or option selectedness. It then reconciles incoming markup and restores the appropriate native properties after the DOM patch. Ignored subtrees, island roots and independently registered nested Live roots remain outside their parent's control plan.

| Control                    | Ordinary unbound behavior                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Text-like and number input | Retain the live value while the incoming default value is unchanged; apply a changed default                                           |
| Textarea                   | Same value rule, and update `defaultValue` so native form reset uses the latest server default                                         |
| Checkbox                   | Retain the local checked choice while the relevant server value/checked defaults stay compatible                                       |
| Radio group                | Preserve its local choice while server group defaults stay unchanged; changed defaults are authoritative                               |
| Single select              | Retain the selected option while explicit defaults stay unchanged; use the incoming selection if an unbound selected choice disappears |
| Multiple select            | Retain each local selection while explicit defaults stay unchanged; changed defaults replace the selection                             |
| File input                 | Keep the existing user selection on a retained file input; never assign a file selection from an incoming string                       |

For example, these values are local browser state because no model directive exposes them:

```html
<form id="local-preferences">
  <label for="local-note">Local note</label>
  <textarea id="local-note" name="note">Initial server note</textarea>
  <label for="local-tags">Local tags</label>
  <select id="local-tags" name="tags" multiple>
    <option data-nv-key="alpha" value="alpha" selected>Alpha</option>
    <option data-nv-key="beta" value="beta">Beta</option>
  </select>
</form>
```

An ordinary Live update that renders the same defaults keeps the user's local note and tag selections. A server response with a different textarea default or explicit selected defaults changes them. The inputs' `name` attributes do not register Live state, and these values are not automatically included in Live request updates. A host may separately submit a normal HTML form through an explicit route; that route remains responsible for validation and CSRF.

Use stable `data-nv-key` or `id` attributes for options that may reorder. Option identity includes the key and value, allowing two options with the same value to retain distinct selection. Repeated unkeyed values rely on occurrence order; provide keys when identity matters. Use valid form structure and unique radio names or distinct forms per component. Native radio grouping can cross DOM ownership boundaries when controls share a form/name in the same tree; isolation for such shared groups is not supported or proven. Do not rely on a visual subtree boundary to change the [HTML radio grouping rules](https://html.spec.whatwg.org/multipage/input.html#radio-button-group).

Radio grouping uses the actual form owner, including a null owner. Different unresolved `form` targets do not create separate groups. Incoming markup is detached during validation, so the client projects explicit internal/external form references into the retained document before deciding which local choices survive. An empty target, missing target or first matching non-form ID yields no owner; an absent `form` attribute can inherit an enclosing form. This follows the [HTML form association rules](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#reset-the-form-owner); the server-default merge remains Nestvexa policy.

## Model-bound drafts

Model controls also require explicitly writable server state. The server remains authoritative except for a newer local edit that the current response has not acknowledged. Preservation requires an original surviving control with the same field, conversion and native control signature. An input type change, model field rename, conversion change or replacement can end that compatibility. The client clears the corresponding stale hidden draft so `client.get()` and the next request agree with the new server control.

```hbs
<label for='title'>Title</label>
<input id='title' nv:model='title' value='{{title}}' />
```

This still needs a registered component declaring writable `title` state and host-owned Live security configuration; see the [counter bootstrap](../../examples/live-counter/README.md). An edit made after a request started can survive an ordinary response when that control remains compatible. An acknowledged edit may be normalized or replaced by server logic. This is not optimistic business transaction rollback or permission to bypass validation.

A newer radio draft is not silently replaced with another option when its chosen value disappears. If a compatible original group control survives, no unmatched radio is selected and the draft remains subject to server validation or a new user choice. File inputs remain unsupported as model values. Multiple-select models now use explicit bounded flat arrays, strict unique option catalogs and shared state projection; see [multiple-select models](multiple-select.md). Unbound duplicate-value options retain the separate native identity policy above; bound multiple catalogs reject ambiguous values.

## Reset and replacement

Changing a server default is an explicit merge signal. Sending the same default again cannot tell the client whether the host intended to keep a local edit or reset it. Use native `HTMLFormElement.reset()` when a host-owned UI needs to reset local controls to their current defaults, or use explicit `nv:replace`/`.self` when the server intends to discard the relevant local DOM state. Textareas and option defaults are updated so reset sees the latest server defaults.

A native reset also reconciles owned model drafts after the browser operation, avoiding a visible reset followed by transmission of a discarded hidden edit. It records newer field versions and cancels affected model timers without automatically sending `_sync` or invoking an action. `preventDefault()` cancels both native reset and reconciliation; synthetic reset-event dispatch does not run the native operation and is ignored. Actual form ownership includes disabled and explicitly associated controls, with client/renderer boundaries preserved. Invalid or ambiguous model defaults cancel the reset rather than silently invent state. See the [native reset guide](form-reset.md) for exact restrictions, field aliases and in-flight response behavior.

```html
<section nv:replace="" aria-label="Resetting editor">
  <label for="temporary-note">Temporary note</label>
  <input id="temporary-note" value="Server default" />
</section>
```

Replacement deliberately resets removed native values, file selections and widget state. When every compatible original model control for a dirty field disappears, that field's pending local edit is cleared. Ordinary file selection preservation does not implement uploads, quotas, ownership tokens, MIME checks, scanning or storage; the uploads subsystem remains separate required work.

Editable content follows an explicit local-state policy: native editable content is retained while editable, whereas `contenteditable=false` follows incoming server content. Use `nv:ignore` for an external editor or widget that owns a whole subtree. Selection restoration checks the updated input's native selection capability, so changing a focused text field to a number/email/file field does not interrupt revision advancement.

An owned inner editable host also preserves one caret/range through keyed moves when its original endpoint nodes survive. No editor HTML is serialized into Live updates. Replacement, cross-editor/renderer selections, ignored plugin editors and inherited focused descendants are outside that selection contract. See [local editable selection](focus-restoration.md#local-editable-selection) for exact capture, host callback and focus ordering rules.

## Registration consistency and handoff

A registration records the exact initial values of these server-created attributes:

| Attribute           | Recorded role                      |
| ------------------- | ---------------------------------- |
| `data-nv-component` | Opaque component instance identity |
| `data-nv-name`      | Registered component name          |
| `data-nv-endpoint`  | Same-origin action endpoint        |
| `data-nv-csrf`      | Host-provided CSRF token           |
| `data-nv-snapshot`  | Server-state reference             |
| `data-nv-revision`  | Expected component revision        |
| `data-nv-state`     | Encoded public state               |

The browser compares raw values, so valid initial JSON whitespace or revision formatting is not rejected merely because the client parses it into normalized values. Its own successful response writes update the recorded values. External changes invalidate the registration, cancel scheduled work, abort its pending request and release client ownership. The failure is reported once; restoring attributes does not silently reactivate it. A host must dispose the client, reconcile trusted markup and explicitly mount again. If an element supplied as the client's root is replaced, create the next client with the new root.

This is a browser consistency check, not a cryptographic proof or an authorization boundary. A hostile browser can bypass the client and send HTTP requests. The server must independently enforce authoritative identity, CSRF/origin checks, state ownership, writable fields, validation and revisions. Do not log or copy snapshot/CSRF attributes into diagnostics.

`nv:ignore` on the Live root itself is invalid. An independent Live root under an ignored ancestor is permitted; the parent does not acquire ownership of that independent subtree. Moving a registered root under an island releases Live ownership and requires explicit host reconciliation before a later Live remount. Since the DOM was not removed, this ownership transfer does not emit invented `nestvexa:before-remove`/`after-insert` events. Real replacement/removal still follows the [documented lifecycle](../reference/directives.md#explicit-replacement-and-removal-lifecycle).

## Evidence and limits

The implementation is in [control-state](../../packages/client/src/control-state.ts), [morph](../../packages/client/src/morph.ts) and the [client](../../packages/client/src/index.ts). The [native-control regressions](../../tests/client-native-controls.test.ts) and [ownership-transition regressions](../../tests/client-ownership-transitions.test.ts) run actual Chromium with controlled transport where needed; they do not establish Nest/server protocol conformance. The [native-control browser scenarios](../../tests/browser/native-controls.spec.ts) exercise the actual Nest sample; consult the current [implementation checkpoint](../implementation/STATUS.md) for executed pass/fail outcomes and pack/runtime evidence.

The full input/modifier/form/reset/accessibility matrix, cross-owner native grouping, external widget lifecycle, teleport behavior, official framework islands, full nested-server component API and upload/form subsystems remain incomplete or unverified. No single fixture certifies those capabilities.
