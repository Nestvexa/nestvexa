# nv:keydown

Call one registered Live action when a matching `keydown` event reaches an owned element:

```hbs
<input aria-label='Search' nv:keydown.enter.prevent='search' />
```

## Syntax and modifiers

The value is a registered action identifier, never an expression. At most one key filter selects the key; without one, every `keydown` that passes the other filters invokes the action.

| Key filter    | Matches `KeyboardEvent.key`   |
| ------------- | ----------------------------- |
| `.enter`      | `Enter`                       |
| `.escape`     | `Escape`                      |
| `.space`      | `' '` (and legacy `Spacebar`) |
| `.tab`        | `Tab`                         |
| `.arrow-up`   | `ArrowUp`                     |
| `.arrow-down` | `ArrowDown`                   |

The remaining modifiers are shared with [`nv:click`](nv-click.md): `.prevent`, `.stop`, `.self`, `.once`, the required system keys `.ctrl`, `.alt`, `.shift`, `.meta` (other pressed keys are allowed), one `.debounce[.Nms]` or `.throttle[.Nms]` scheduler (default 250ms, 1–60000ms), and one `.window` or `.document` scope. Multiple key filters, unknown key names, duplicate modifiers and a scope combined with `.self` or `.stop` are rejected. Event kind, disabled control, `.self`, key and system-key filters run before `.prevent`/`.stop`, so a non-matching key keeps its native behavior. The full order and the scope rules are in [event modifiers and scopes](nv-events.md).

`nv:keydown.window.escape` and `nv:keydown.document.escape` listen on the owning window or document while the declaring element stays owned by a healthy component, and accept only trusted (user-agent generated) events, so page scripts cannot synthesize the hotkey.

## Server contract

As for [`nv:click`](nv-click.md#server-contract): the value names an `@Action()` reached through `POST <endpoint>/<component>/<action>`, explicitly permitted by the host `authorize` callback, with origin, CSRF, identity, revision and writable-state checks. Only the action name and pending model drafts are sent; the key, modifiers and event object never reach the server.

## Security

A keyboard shortcut is input routing, not permission. A global scope does not widen what the server allows, and the trusted-event check only protects against script-synthesized hotkeys in the page. Use `.prevent` deliberately: preventing `Tab` traps keyboard users.

## Accessibility

Keep shortcuts discoverable (visible text or `aria-keyshortcuts`) and provide an equivalent button for every keyboard-only action. Inside a form, Enter already submits implicitly, so use [`nv:submit`](nv-submit.md) there and keep `nv:keydown.enter.prevent` for inputs whose Enter must not submit. Avoid overriding keys assistive technology relies on, and do not bind single printable characters without a modifier.

## Example

<!-- snippet: examples/live-counter/views/counter.hbs -->

```html
<label for="keyboard">Keyboard action</label
><input id="keyboard" nv:keydown.enter.prevent="increment" />
<label for="shortcut">Control shortcut</label
><input id="shortcut" nv:keydown.ctrl.enter.prevent="increment" />
```

A window-scoped hotkey from the directive lab, with the action it calls:

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<span nv:keydown.window.escape="hotkey" hidden>Escape counts a hotkey</span>
```

<!-- snippet: examples/directive-lab/src/main.ts -->

```ts
  @Action() hotkey(): void {
    this.hotkeys++;
  }
```

## Verification

[Grammar matrix](../../tests/client-directive-grammar.test.ts) (every key filter × flags × scheduler × scope), [event tests](../../tests/client-events.test.ts), [Chromium/Firefox/WebKit combination rows](../../tests/client-directive-combinations.test.ts) (every key filter with `.prevent`, `.shift.enter.prevent`, `.window.escape`, `.document.escape` with untrusted events rejected, debounced global repeats, release on server removal, `nv:confirm`), [runtime resilience](../../tests/client-runtime-resilience.test.ts), and the real-server [event scenarios](../../tests/browser/events.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
