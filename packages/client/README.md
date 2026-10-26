# @nestvexa/client

Small experimental browser-only Live client. Import `createLiveClient` and explicitly call `mount()`; `dispose()` removes listeners, observers and aborts in-flight requests. Imports do not touch DOM globals. No Nest or frontend framework dependencies are included.

```js
import { createLiveClient } from '@nestvexa/client';
const client = createLiveClient({
  onError(error) {
    console.error(error.message);
  },
});
client.mount();
```

Install local packed artifacts while unpublished. Future npm/pnpm/yarn package name is `@nestvexa/client`. ESM output requires modern browsers with fetch, AbortController, crypto.randomUUID and MutationObserver. The local matrix includes Chromium, Firefox and WebKit; consult the latest report for pass/fail outcomes.

Implemented directives: click, submit, keydown, deferred model, loading, ignore, text, show, bind, dirty, cloak and ref. Event modifiers support prevent/stop/self/once, keyboard/system filters, debounce and leading throttle; see the [exact grammar](../../docs/reference/directives.md). Unsupported modifiers/directives are rejected explicitly. Expressions are not evaluated. The optional [Alpine adapter](../alpine/README.md) supplies `$live.call/get/set` inside an ignored ownership boundary. The full master directive matrix remains unmet.

A component root has one active client owner. A second client cannot attach competing listeners; dispose the owner before transferring it. Removed component roots abort pending requests, discard queued actions and cancel event timers. Failed mount markers are reported once and require disposing/remounting the client after correction.

`client.call(element, action)` returns the queued request promise. `get(element, field)` returns detached state or local edits. `set(element, field, primitive)` updates local state until submitted. `refs(element)` resolves owned references from the current DOM. Server authorization and writable-state checks always apply.

Requests are serialized per component, capped at16 pending operations, sent same-origin with host CSRF token, and never automatically retried. Duplicate submits are suppressed. Response identity/request/revision checks precede DOM updates. Keyed nodes retain identity; nested live/ignored/island roots are ownership boundaries. Focus/caret and newer input edits are preserved where tested; advanced teleport/select/file behavior requires further acceptance work.

Render only trusted application templates. The client rejects active document tags, non-HTML namespaces and inline event handlers in updates; this is defense in depth, not a general HTML sanitizer. Use server escaping and a restrictive CSP. Errors go to `onError` or `nestvexa:error`; successful updates emit `nestvexa:updated`.

See the [cookie-backed example](../../examples/live-counter/README.md), [protocol](../../docs/guides/live-protocol.md), [changelog](../../CHANGELOG.md). Run `pnpm test` / `pnpm test:e2e` at root. No maintainer/repository identity is invented while owner details remain pending.
