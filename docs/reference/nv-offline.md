# `nv:offline`

Present a connectivity hint inside a Live component. The signal combines the browser's advisory `navigator.onLine` flag with a failed request recorded for that component. A successful request clears that component's request failure; an `online` event alone does not prove the server is reachable. These indicators do not block, retry or queue requests. The [HTML network-state contract](https://html.spec.whatwg.org/multipage/system-state.html#browser-state) explicitly describes the browser signal as unreliable.

```hbs
<p nv:offline role='status'>Connection may be unavailable. Try again.</p>
<p nv:offline.remove>Connection appears available.</p>
<button nv:offline.class='connection-warning' type='button'>Retry</button>
```

The closed grammar is:

| Declaration                         | Effect while offline or after a request connectivity failure |
| ----------------------------------- | ------------------------------------------------------------ |
| `nv:offline=""`                     | Show; hide while the signal is clear                         |
| `nv:offline.remove=""`              | Hide; show while the signal is clear                         |
| `nv:offline.class="muted"`          | Add the listed classes                                       |
| `nv:offline.class.remove="ready"`   | Remove the listed classes                                    |
| `nv:offline.attr="disabled"`        | Set the allowlisted attribute                                |
| `nv:offline.attr.remove="readonly"` | Remove the allowlisted attribute                             |

Classes are 1–16 unique tokens matching `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Attributes are `disabled`, `readonly`, `aria-disabled`, or `aria-busy`. Native disabled/readonly applicability is checked; ARIA attributes do not enforce interaction behavior. Avoid disabling all recovery actions on an advisory signal. Attribute variants are explicit author choices, suitable for actions that have another recovery path.

Visibility updates manage both `hidden` and `aria-hidden`. The component root cannot be hidden. Focus moves to the visible component root before a focused descendant becomes unavailable; if that fallback fails, the visibility effect is rejected. Loading/show/dirty/bind effects cannot claim the same controlled property. Nested Live roots, whole `nv:ignore` subtrees and framework islands are excluded from parent ownership.

Captured classes and attributes are restored on cleanup, unless a later host write changed the controlled value. Server markup must be applied after presentation restoration so new server values become the new baseline. No template expression, JavaScript, arbitrary attribute, style or URL is evaluated.

For an embedding runtime, `createPresentationController({ window, onError, focus? })` exposes `refresh(root)`, `restore(root)`, `setNetworkFailure(root, failed)`, `remove(node)`, and `dispose()`. Pass `true` for transport connectivity failures, rather than treating validation/authentication/HTTP errors as proof of offline status. Components have separate failure flags. After logout or component teardown, remove their registration. The controller is browser-only and does not authorize server actions.

When a component suspends after an uncertain failure, its offline declarations stay registered rather than reverting to server markup. A dropped connection or request deadline therefore shows the hint, while a 500, malformed or stale response suspends transport without claiming an outage. After the host reconciles (reload or dispose/remount) a successful request clears the request-failure flag. `nv:offline` has no `.delay` modifier.

Verification: [error-recovery rows](../../tests/client-runtime-resilience.test.ts) and the [directive lab](../../tests/browser/directive-lab.spec.ts) cover suspension with and without connectivity failures; [parser and real Chromium lifecycle tests](../../tests/client-presentation.test.ts) cover actual browser network events, scoped failures, focus, restoration, ownership and malicious declarations. This reference does not promise offline execution, drafts or service-worker caching.
