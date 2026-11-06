# `nv:loading`, `nv:target` and `.delay`

Show, hide, add classes to or set allowlisted attributes on an owned element while matching Live requests are queued or running. The grammar, ownership and restoration rules are summarized in the [directive reference](directives.md#loading-and-targets); this page adds the activation delay and the tested combinations.

```hbs
<button
  type='button'
  nv:click='save'
  nv:loading.attr='disabled'
  nv:target='save'
>Save</button>
<span
  role='status'
  nv:loading.delay=''
  nv:target='save,$sync'
  hidden
>Saving…</span>
<button
  type='button'
  nv:click='slow'
  nv:loading.attr.delay.400ms='aria-busy'
>Slow</button>
```

## Grammar

`nv:loading[.class|.attr][.remove][.delay[.<N>ms]]`, with modifiers in exactly that order.

| Declaration                    | Effect while matching work is pending                       |
| ------------------------------ | ----------------------------------------------------------- |
| `nv:loading=""`                | Show (manages `hidden` and `aria-hidden`)                   |
| `nv:loading.remove=""`         | Hide                                                        |
| `nv:loading.class="a b"`       | Add 1–16 simple class tokens                                |
| `nv:loading.class.remove="a"`  | Remove the tokens                                           |
| `nv:loading.attr="disabled"`   | Set `disabled`, `readonly`, `aria-disabled` or `aria-busy`  |
| `nv:loading.attr.remove="..."` | Remove the attribute                                        |
| `….delay` / `….delay.750ms`    | Activate only after 200ms / the given 1–10000ms             |
| `nv:target="save,$sync"`       | Count only these actions (`$sync` is model synchronization) |

All loading declarations on one element share one delay; mixing delayed and immediate declarations on the same element, a delay outside 1–10000ms, a delay in seconds, a duplicate `.delay` or a delay before `.remove` is rejected. `nv:offline` has no delay modifier.

## Delay semantics

- The delay starts when matching work becomes pending. If every matching request settles first, the effect is never applied, so fast actions do not flash an indicator (tested with a `MutationObserver` that records zero visible states).
- Once shown, the effect stays until matching work settles, then restores immediately.
- Applying server markup restores loading baselines first. If matching work is still queued after a response (for example a second queued action), the delay restarts for the new markup, so a long queue can briefly hide a delayed indicator between responses. Use an immediate indicator where continuous feedback across queued requests matters.
- Suspension, element removal, reconfiguration and client disposal cancel a pending delay timer before it can write.

## Accessibility

Pair visibility effects with `role="status"` (polite) and render the element `hidden` in server markup so the baseline is correct before and after the client manages it. Component roots get `aria-busy="true"` while any request is pending regardless of targets. A delayed status avoids announcing work that completes quickly; disabling a control with `.attr="disabled"` removes it from the tab order, so prefer `aria-disabled` when focus must stay on the control.

## Verification

[Grammar matrix](../../tests/client-directive-grammar.test.ts) (every effect × remove × delay, offline parity), [Chromium combinations](../../tests/client-directive-combinations.test.ts) (targets, `$sync`, concurrent per-action counts, delays for quick and slow work, server-disabled baselines, submitter disabling), [loading controller tests](../../tests/client-loading.test.ts) and the [directive lab browser scenarios](../../tests/browser/directive-lab.spec.ts) in Chromium, Firefox and WebKit.
