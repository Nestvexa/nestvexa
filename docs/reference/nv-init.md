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
expression. Empty values, `load()`, dotted names and reserved identifiers are
rejected. The supported timing modifiers are `.visible` and `.idle`; `.lazy`,
`.once`, combinations of timings and event-style modifiers are errors. Two owned
declarations in one component are an error, including different timing variants.
Nested Live roots have independent registrations; whole-ignore and framework
island descendants are excluded. `nv:init` cannot share an element with
`nv:confirm`: automatic initialization must not trigger a consent prompt.

## Timing and lifetime

Bare `nv:init` queues a microtask after discovery. In the default umbrella entry,
the synchronous client mount and Alpine startup finish before dispatch. This is
eager initialization: visibility, a hidden attribute or a disabled control does
not delay it. Asynchronous host plugins must arrange their own readiness.

`nv:init.visible='load'` waits for a native `IntersectionObserver` observation
intersecting the viewport while the document is visible. Viewport edge contact
counts; intersection does not prove that a human saw unobscured content. If an
intersecting observation occurs in a hidden document, dispatch waits until the
document becomes visible. The observer is released before the attempt runs.
Missing native observer support produces an explicit error; content is never
silently loaded eagerly as a fallback.

`nv:init.idle='load'` uses `requestIdleCallback` with a 1,000ms timeout. Where
the API is unavailable, a 100ms timer supplies a bounded scheduling fallback.
These are event-loop scheduling hints, not real-time deadlines; a blocked browser
can deliver them later. Idle timing does not imply viewport visibility or an
online connection. Neither timing defers the initial server component mount:
render meaningful placeholder HTML initially and choose which optional content
the authorized action loads. Server-side lazy component mounting remains a
separate capability.

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
capacity rejection and server errors never cause automatic retry. Native
observers, idle callbacks and fallback timers are released when their element is
removed, reconfigured, ignored, handed to another renderer or the client is
disposed. Reintroducing
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
to the latest implementation report for executed results. Server-side lazy
hydration and manual assistive-technology acceptance remain separate requirements.
The controlled Chromium corpus also covers actual viewport entry, native idle
scheduling, timer fallback, hidden documents, cancellation and mixed timing
declaration rejection.

This additive alpha API adds a browser scheduler asset and introduces no package
dependency or Live protocol change. Existing pages without `nv:init` do not acquire
automatic actions; bare `nv:init` retains its eager timing. Timing follows the
[W3C Intersection Observer](https://www.w3.org/TR/intersection-observer/) and
[cooperative idle scheduling](https://w3c.github.io/requestidlecallback/) contracts.
