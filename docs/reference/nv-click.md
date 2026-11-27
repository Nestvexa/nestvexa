# nv:click

Call one registered Live action when an owned element is clicked:

```hbs
<button type='button' nv:click='increment'>Increase</button>
```

## Syntax and modifiers

The value is a registered action identifier (`/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`, not `constructor`, `__proto__` or `prototype`). It is never JavaScript: `increment()`, arguments, dotted paths and empty values are rejected with a `DIRECTIVE` error before any listener runs.

| Modifier                           | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `.prevent`                         | `preventDefault()` after the filters accept the event (for example a link) |
| `.stop`                            | Stop propagation from a direct element listener                            |
| `.self`                            | Accept only clicks whose target is the element itself                      |
| `.once`                            | Attempt the action once per element and configuration                     |
| `.ctrl`, `.alt`, `.shift`, `.meta` | Require those system keys                                                  |
| `.debounce[.Nms]`                  | Trailing call after a quiet interval (default 250ms, 1–60000ms)            |
| `.throttle[.Nms]`                  | Leading call, then suppress clicks within the interval                     |
| `.window`, `.document`             | Listen on the owning window/document for trusted clicks                    |

Key filters (`.enter` and friends) belong to [`nv:keydown`](nv-keydown.md). Duplicate modifiers, mixed debounce/throttle, both scopes together and a scope combined with `.self` or `.stop` are rejected. The filter and side-effect order, `.once` consumption and the scope rules are specified in [event modifiers and scopes](nv-events.md).

A disabled control, including one inside a disabled `fieldset`, never invokes its action. Clicks are handled by one delegated listener on the component; `.stop` and scoped bindings use direct listeners that are removed when the element leaves the component or the client is disposed. The browser event object is never serialized.

## Server contract

The action must be a `@Action()` method of the component, reached through the generated `POST <endpoint>/<component>/<action>` route. The host `authorize` callback (or the kernel policy registry) receives the action name and must permit it explicitly. Each call carries the component snapshot, its rendered revision and any pending [`nv:model`](nv-model.md) drafts as `updates`; the server checks origin, the `x-nestvexa-csrf` token, identity binding, revision and writable state before the method runs. Calls are serialized per component (at most 16 queued operations), and a stale revision is `409 STALE_REVISION`. See the [Live protocol](live-protocol.md).

## Security

A click is user input routing only. Hiding or disabling a button does not prevent a forged request, so authorization, validation and ownership checks belong on the server. `.once` and throttling are UI affordances, not idempotency: use `@Action({ idempotent: true })` or host idempotency for effects that must not repeat. Combine with [`nv:confirm`](nv-confirm.md) for consent prompts and [`nv:optimistic`](nv-optimistic.md) for projected state; neither replaces server checks.

## Accessibility

Put `nv:click` on a native `<button type="button">` (or a link that really navigates) so keyboard Enter/Space activation, focus and the accessible role come from the browser; the combination matrix verifies keyboard activation of buttons. A `div` with `nv:click` is not keyboard operable. Pair long actions with [`nv:loading`](nv-loading.md) and a `role="status"` message. Component roots get `aria-busy="true"` while a request is pending.

## Example

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<button type="button" nv:click.once="increment">Once increase</button>
<button type="button" nv:click.debounce.100ms="increment">
  Debounced increase
</button>
<button type="button" nv:click.throttle.500ms="increment">
  Throttled increase
</button>
```

<!-- snippet: examples/live-counter/src/main.ts -->

```ts
  @Action() increment(): void {
    this.count++;
  }
  @Action() decrement(): void {
    this.count--;
  }
```

The live-counter host authorizes `increment` and `decrement` (with `$mount` and `$sync`) in its `authorize` callback.

## Verification

[Grammar matrix](../../tests/client-directive-grammar.test.ts), [event parser and dispatcher tests](../../tests/client-events.test.ts), [Chromium/Firefox/WebKit combination rows](../../tests/client-directive-combinations.test.ts) (disabled controls and fieldsets, keyboard activation, `.prevent` links, `.stop`, `.self`, `.once`, schedulers, system keys, scopes), [lifecycle regressions](../../tests/client-lifecycle.test.ts), and real Nest servers in the [event browser scenarios](../../tests/browser/events.spec.ts), [counter suite](../../tests/browser/live.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
