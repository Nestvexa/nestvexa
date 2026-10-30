# nv:init

Declare one owned initializer per Live component to call a registered action:

```hbs
<section nv:init='load'>
  <p role='status'>{{message}}</p>
  <span nv:loading nv:target='load' hidden>Loading content</span>
  <button type='button' nv:click='load'>Load explicitly</button>
</section>
```

The value is a simple action identifier, never JavaScript or an argument
expression. Empty values, `load()`, dotted names, reserved identifiers and all
modifiers are rejected. Two owned declarations in one component are an error.
Nested Live roots have independent registrations; whole-ignore and framework
island descendants are excluded. `nv:init` cannot share an element with
`nv:confirm`: automatic initialization must not trigger a consent prompt.

## Timing and lifetime

The client queues a microtask after discovery. In the default umbrella entry,
the synchronous client mount and Alpine startup finish before dispatch. This is
eager initialization: visibility, a hidden attribute or a disabled control does
not delay it. Asynchronous host plugins must arrange their own readiness.
Lazy/deferred component timing and intersection scheduling remain unimplemented;
`.lazy`, `.visible` and `.once` are not supported aliases.

An attempt belongs to the component registration, rather than to the initializer
element. Ordinary updates, keyed moves, replacing that inner element, repeated
`mount()` and persisted page transitions do not run it again. A component with
no initializer may acquire its first declaration in a later valid fragment.
New independent component registrations receive their own attempt. Explicit
disposal/remounting creates a new registration and can run the action again with
the current snapshot. This is not a durable exactly-once or idempotency guarantee.

The attempt is consumed before scheduling. Removal, disposal, changed markers,
changed action text, an ownership handoff or an uncertain transport failure before
dispatch cancels it. The client validates owned directives again at dispatch,
including duplicate declarations introduced in the same turn. Cancellation,
capacity rejection and server errors never cause automatic retry. Reintroducing
an initializer on the same registration does not reset the consumed attempt.
An explicit user action remains subject to the normal transport recovery policy.

At most **64 attempts per mounted client lifecycle** are allowed by default.
Manual entries may set `createLiveClient({ maxInitializations: 32 })`; the value
must be an integer from 1 through 1,000. Capacity counts attempts across component
registrations until explicit disposal/remounting, rather than concurrent requests.
It is separate from the existing 16-operation per-component queue limit. Large
documents should avoid automatic requests for every component. Excess attempts
report `DIRECTIVE` through `onError`/`nestvexa:error` without dispatching HTTP.

## Security and fallback

Initialization uses the ordinary serial action queue, loading state, bounded
transport, revision checks and safe fragment reconciliation. It sends no extra
wire fields or privileged lifecycle claim. The server still applies the generated
Nest route, host authorization, guards/pipes/interceptors/filters, CSRF, origin,
session ownership and writable-state validation. A hidden button or an initializer
cannot grant permission. Choose read-only or repeat-safe initialization actions;
use host-owned idempotency for important effects. Aborting a browser request does
not undo server work. This directive does not implement a server `init` hook.

Without JavaScript, only the initial server HTML is available. Render meaningful
initial content or a normal link/form fallback where needed; the directive itself
does not add a progressive action route. Optional content should not be required
for authorization or essential navigation.

See the [startup panel](../../examples/starter-live/views/startup-panel.hbs) at
`/init`, and `/init/denied` for a host policy that denies `load` while permitting
`refresh`. The [controlled Chromium corpus](../../tests/client-lifecycle.test.ts)
covers lifetime, cancellation, capacity and malformed declarations. The
[real-server browser suite](../../tests/browser/initialization.spec.ts) covers
Alpine retention, loading, denied actions, CSRF/session isolation, no-JavaScript
HTML and automated accessibility across the configured browser engines. Refer
to the latest implementation report for executed results. Lazy hydration and
manual assistive-technology acceptance remain separate requirements.

This additive alpha API introduces no package dependency, asset module or Live
protocol change. Existing pages without `nv:init` do not acquire automatic actions.
