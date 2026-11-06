# `nv:click`, `nv:submit`, `nv:keydown` and their modifiers

Event directives invoke one registered action. The value is an identifier, never an expression; modifiers are a closed grammar parsed before any listener runs. The base contract is in the [directive reference](directives.md#event-modifiers); this page documents scopes, precedence and the combination results proven by the matrix.

```hbs
<button type='button' nv:click.once='publish'>Publish once</button>
<input aria-label='Search' nv:keydown.enter.prevent.debounce.300ms='search' />
<dialog open>
  <button
    type='button'
    nv:click='close'
    nv:keydown.window.escape='close'
  >Close</button>
</dialog>
<div nv:click.document='dismiss'>Menu</div>
```

## Modifiers

| Modifier                                                     | Applies to               | Meaning                                                 |
| ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------- |
| `.prevent`, `.stop`, `.self`, `.once`                        | all                      | Filters/effects; `.stop` uses a direct element listener |
| `.ctrl`, `.alt`, `.shift`, `.meta`                           | all                      | Required system keys; extra pressed keys are allowed    |
| `.enter` `.escape` `.space` `.tab` `.arrow-up` `.arrow-down` | `nv:keydown`             | One key filter                                          |
| `.debounce[.Nms]`, `.throttle[.Nms]`                         | all                      | One scheduler, 1–60000ms, default 250ms                 |
| `.window`, `.document`                                       | `nv:click`, `nv:keydown` | Listen on the owning window/document                    |

Modifier order is free except that an interval must directly follow its scheduler. The [grammar matrix](../../tests/client-directive-grammar.test.ts) checks every subset of the eight flags × key × scheduler × scope × event kind in forward and reversed order against an independent oracle (more than 10,000 accepted and 10,000 rejected names).

## Precedence

1. Event kind, disabled control (`:disabled`, including a disabled fieldset), `.self`, key and system-key filters run first. A rejected event has no side effect.
2. `nv:confirm` (when present) prevents the native default for every matching event, including suppressed repeats.
3. `.once` consumption and the throttle window are checked; a suppressed event returns without `.prevent`/`.stop`.
4. `.prevent`, then `.stop`, are applied.
5. `.debounce` schedules a trailing call; otherwise the action is invoked immediately.

Owned Live forms always prevent native submission, even when `.once`, throttling, a pending submit or a denied confirmation suppresses the action. `.once` is consumed by the attempt, including an attempt that a confirmation dialog denies; it never retries an action that may have run.

## Window and document scopes

A scoped binding listens on the declaring element's own `window` or `document` and invokes the element's component action for matching events anywhere in that document. It is safely scoped as follows:

- it exists only while the declaring element is owned by a healthy, mounted registration: removing the element (including by server markup), ignoring it, moving it into an island, suspending the component or disposing the client releases or disarms the listener;
- only trusted (user-agent generated) events are accepted, so page scripts cannot synthesize a hotkey with `dispatchEvent`;
- `.self` (cannot match a global target) and `.stop` (a window listener runs too late) are rejected, as are both scopes together and scopes on `nv:submit`;
- the ordinary delegated path ignores scoped declarations, so an event inside the element triggers the action once, not twice;
- `.once`, debounce/throttle, key and system-key filters and `.prevent` behave as for element bindings.

A scope is user input routing only. The action is still authorized and validated by the server.

## Verification

[Chromium combination rows](../../tests/client-directive-combinations.test.ts) cover disabled controls and fieldsets, keyboard activation, `.prevent` with and without links, `.stop` against native ancestors, `.self`, `.once`, debounce/throttle bursts, `.once.debounce`, required system keys, filter ordering for `.prevent.stop.self`, every key filter with `.prevent`, global window/document hotkeys, untrusted synthetic events, `.document.once`, release on server removal and debounced global repeats. Submission rows cover duplicate suppression while pending, nested submit buttons, implicit Enter submission, native constraint validation, `.debounce` and a pending-disabled submitter. The [directive lab](../../tests/browser/directive-lab.spec.ts) repeats the core flows against a real Nest server in Chromium, Firefox and WebKit.
