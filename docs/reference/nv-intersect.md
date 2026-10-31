# nv:intersect

Call a registered action when an owned element intersects the browser viewport:

```hbs
<section nv:intersect.once='loadMore'>
  <p role='status'>{{message}}</p>
  <button type='button' nv:click='loadMore'>Load explicitly</button>
</section>
```

The only modifier is `.once`. Without it, the action runs on an initial
intersecting observation and each subsequent entry after an observed exit. It
does not run for every scroll event. An edge touching the viewport counts as
intersection under the native API; this is geometric intersection, not a proof
that a human saw unobscured content. The action is a simple registered identifier,
never a JavaScript expression, selector, module path or argument list.

## Attempts and lifecycle

`.once` consumes one attempt per retained binding, including server rejection
or transport failure. Ordinary discovery and server morphs retaining the same
element/configuration do not retry it. Removing and recreating the binding or
explicitly disposing and remounting creates a new lifetime. This is not durable
exactly-once execution or server idempotency.

Repeated entries while a call is pending never overlap or accumulate queued
replays. Hidden/offline documents and native disabled controls do not dispatch.
If an entry is skipped, a later observed exit and entry are required; returning
online does not automatically replay it. The controller checks registration,
ownership and unchanged directive configuration again before invoking.

Moving to another component, removal, whole-ignore or island ownership handoff,
reconfiguration, component failure and client disposal unobserve and release the
binding. `.once` stops observing after its attempt while retaining bounded
lifetime information. Poll and intersection bindings share the client's default
256-binding capacity (`maxObservers`, integer 1 through 1,000).

The runtime uses native `IntersectionObserver` with the top-level viewport and
threshold zero. Missing platform support is an explicit directive error; it does
not silently execute all actions or install a scroll polling fallback. No custom
root, margin, visibility tracking or threshold modifier is currently supported.

## Authorization and fallback

Intersection dispatch uses the same protected action queue as user interactions.
Guards, input validation, session/tenant binding, CSRF, origin, revisions and
server authorization remain authoritative. Only explicitly registered actions
are callable. Choose read-only or repeat-safe actions; viewport events are not
consent to irreversible work. `nv:confirm` on the same element is rejected.

Nested Live roots, whole-ignore and framework-island boundaries retain separate
ownership. Render meaningful initial HTML and a normal link or form when essential
content must work without JavaScript. This directive schedules an action after
the Live registration exists; it does not by itself defer server mounting or
authorize otherwise inaccessible data.

The [Chromium tests](../../tests/client-observers.test.ts) exercise native viewport
entry/exit, repeat and once lifetimes, rejection, cleanup and strict grammar.
Consult the implementation report for executed integration/browser coverage;
these tests alone do not establish the complete Phase 4 gate.

The scheduling follows the [W3C Intersection Observer contract](https://www.w3.org/TR/intersection-observer/).
It adds no wire fields or new protocol major version.
