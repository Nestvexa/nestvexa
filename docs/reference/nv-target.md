# nv:target

Restrict the loading effects on the same element to particular actions:

```hbs
<button type='submit' nv:loading.attr='disabled' nv:target='save'>Save</button>
<span role='status' nv:loading='' nv:target='$sync' hidden>Syncing</span>
```

## Syntax and modifiers

The value is a comma-separated list of 1 through 16 unique action identifiers. `$sync` is also allowed and names the model synchronization request made by `nv:model.live`, `.blur`, `.change` and timed models. Empty items, duplicates, dotted paths, expressions and modifiers are rejected.

`nv:target` only configures [`nv:loading`](nv-loading.md) declarations on the **same element**; without one it is an error. The element's effects are active while any listed name has a positive pending count; counts include queued and running requests and are isolated per component. Without `nv:target`, any pending request of the component activates the effects. The component root's `aria-busy` ignores targets and reflects every pending request.

## Server contract

None. Target names are matched against the action names the client queues; they do not expose methods, register actions or grant permission. A target naming an action the component does not have is simply never active.

## Security

Loading state is presentation. A control disabled while `save` is pending can still be bypassed by a forged request, so the server keeps authorizing and validating every call (and rejects stale revisions).

## Accessibility

Target the status message at the work it describes, so a quick unrelated action does not announce "Saving…". Prefer `aria-disabled` over `disabled` when focus must stay on the busy control.

## Example

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<button
  id="slow"
  type="button"
  nv:click="slow"
  nv:loading.attr="disabled"
  nv:target="slow"
>
  Slow increment
</button>
<span
  id="slow-status"
  role="status"
  nv:loading.delay.150ms=""
  nv:target="slow"
  hidden
  >Working…</span
>
```

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<span id="syncing" nv:loading="" nv:target="$sync" hidden>Syncing</span>
```

## Verification

[Loading parser and controller tests](../../tests/client-loading.test.ts), the [grammar matrix](../../tests/client-directive-grammar.test.ts), [combination rows](../../tests/client-directive-combinations.test.ts) (targets, `$sync`, concurrent per-action counts) and the real-server [replacement and loading scenarios](../../tests/browser/replacement-loading.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
