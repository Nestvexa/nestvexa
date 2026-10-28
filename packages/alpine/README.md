# @nestvexa/alpine

Alpine adapter for the Nestvexa Live client. `installLiveAlpine` registers `$live.call`, `$live.get`, and `$live.set` through Alpine's public magic API. `startLiveAlpine` additionally supports explicitly delegated startup. Importing the package does not touch browser globals or install a runtime.

## Installation

This package is unpublished. Install the local tarballs produced by `pnpm build && pnpm test:pack`. After owner-authorized publication, use `npm install @nestvexa/alpine @alpinejs/csp`, `pnpm add @nestvexa/alpine @alpinejs/csp`, or the corresponding `yarn add` command.

The adapter depends on `@nestvexa/client`. Provide exactly one host Alpine runtime. Stable Alpine 3.17.x is the current compatibility boundary; the browser fixture uses the CSP build3.17.5. `@alpinejs/csp` and `alpinejs` are optional peers because the host selects one runtime. The standard Alpine build requires a different CSP policy; use the CSP build when unsafe-eval is forbidden.

## Startup

```js
import Alpine from '@alpinejs/csp';
import { createLiveClient } from '@nestvexa/client';
import { installLiveAlpine } from '@nestvexa/alpine';

const client = createLiveClient();
client.mount();
installLiveAlpine(Alpine, client);
Alpine.start();
```

Install after loading Alpine and before calling `Alpine.start()`. If the host already owns Alpine startup, register during its initialization hook and do not start it twice. Reinstalling this adapter with the same Alpine/client pair is idempotent. Binding one Alpine instance to a different client throws. Cross-copy or pre-existing unrelated `$live` plugin detection is not guaranteed; applications must assign one integration owner.

For a fresh document whose startup is delegated to Nestvexa, replace those three startup calls with `const app = startLiveAlpine(Alpine, client)`. Import it from this package. Optional `{ document, configure }` supplies an attached document and a trusted synchronous extension hook after bridge installation but before mount/start. The returned frozen application exposes `alpine`, `client`, and idempotent `dispose()`.

One document owns one application, including across copies of the bootstrap package. A repeated startup with the same Alpine returns the existing application; a different runtime or visible host `window.Alpine` rejects. Undisclosed already-started Alpine cannot be detected using public APIs, so delegated mode requires fresh startup. Persisted pagehide retains the same client/drafts for BFCache; nonpersisted departure disposes Live and removes its page listener. This does not stop or destroy Alpine DOM. Failed/disposed startup leaves a reload-only tombstone, preventing unsafe partial restart. Cleanup failures are surfaced. Existing host startup must keep using `installLiveAlpine`.

## Local DOM ownership

This initial integration requires Alpine markup inside an `nv:ignore` subtree nested under a Live component:

```html
<div nv:ignore="" x-data="{ local: 0 }">
  <button type="button" x-on:click="local++">Local increment</button>
  <span x-text="local"></span>
  <button type="button" x-on:click="$live.call('increment')">
    Server increment
  </button>
  <span x-text="$live.get('count')"></span>
</div>
```

Alpine owns that local subtree; Live morphing leaves it intact. `$live.get(name)` reads public state and subscribes Alpine's current reactive expression to committed `nestvexa:updated` events. `$live.set(name, value)` stages a primitive value through the client and updates the local facade; it does not authorize or commit a server mutation. `$live.call(action)` uses the client's bounded request scheduler and returns its promise. Server policies, writable-state declarations, CSRF, identity binding and revision checks remain authoritative.

The adapter caches a facade per element and registers cleanup with Alpine. Removal unsubscribes the listener and invalidates stale references. Nested component update events do not refresh the wrong owner. Reparenting to another Live component is rejected; remount a fresh Alpine element instead.

`$live.state`, entanglement, dispatch/on subscriptions, arbitrary mixed DOM ownership, teleport handling and the full Live directive set are not implemented here. No expression evaluator is added by Nestvexa. Templates are trusted application code.

## Public API and verification

Exports: `installLiveAlpine`, `startLiveAlpine`, `AlpineHost`, `AlpineMagicUtilities`, `LiveClientBridge`, `LiveMagic`, `AlpineRuntime`, `ManagedLiveClient`, `StartLiveAlpineOptions`, and `LiveAlpineApplication`. Delegated startup defaults to the current document. There are no import-time startup side effects.

At repository root run `pnpm exec vitest run tests/alpine.test.ts tests/alpine-start.test.ts` and `pnpm test:e2e`. The startup tests use Chromium with the actual CSP runtime/client and explicitly controlled transport fixtures. Browser examples exercise real server requests. See the [default starter](../../examples/starter-live/README.md), [Live counter](../../examples/live-counter/README.md), [client package](../client/README.md), [security policy](../../SECURITY.md), [status](../../docs/implementation/STATUS.md), and [changelog](../../CHANGELOG.md). Maintainer identity and official repository URLs await owner input. ESM only; no dual-module identity promise.
