# @nestvexa/alpine

Alpine adapter for the Nestvexa Live client. `installLiveAlpine` registers `$live.call`, `$live.get`, and `$live.set` through Alpine's public magic API. `startLiveAlpine` additionally supports explicitly delegated startup. Importing the package does not touch browser globals or install a runtime.

## Installation

This package is unpublished. Install the local tarballs produced by `pnpm build && pnpm test:pack`. After owner-authorized publication, use `npm install @nestvexa/alpine @alpinejs/csp`, `pnpm add @nestvexa/alpine @alpinejs/csp`, or `yarn add @nestvexa/alpine @alpinejs/csp`. The `nestvexa` umbrella package already depends on this adapter and `@alpinejs/csp` 3.17.5, and its default browser bootstrap uses it, so a default install needs no separate step.

The adapter depends on `@nestvexa/client`. Provide exactly one host Alpine runtime. Stable Alpine 3.17.x is the current compatibility boundary; the browser fixture uses the CSP build 3.17.5. `@alpinejs/csp` and `alpinejs` are optional peers because the host selects one runtime. The standard Alpine build requires a different CSP policy; use the CSP build when unsafe-eval is forbidden.

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

### Host-owned Alpine

`adoptLiveAlpine(alpine, client, { document?, configure? })` binds Live to an Alpine the page already owns (a CDN build or an application bundle): it validates the supported version and extension APIs, registers `$live`, mounts the client and never calls `start()`. Adopt before the page starts Alpine so first-render expressions see `$live`. It shares document ownership with `startLiveAlpine`: adopting the Alpine that `startLiveAlpine` already started returns that application, and `startLiveAlpine` refuses an adopted host. `hostAlpine()` returns `window.Alpine` only when it is a plain data property (accessors are never invoked). The default `boot.js` adopts a host Alpine when present and starts the bundled CSP Alpine otherwise. Only Alpine 3.17.x is accepted and tested; other versions are rejected before mounting.

## Local DOM ownership

The integration requires Alpine markup inside an `nv:ignore` subtree nested under a Live component:

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

`$live.dispatch(name, payload)` delivers a browser event to `@OnEvent` listeners through the client. `$live.on(name, callback)` observes `nestvexa:event` deliveries with that name: the callback receives a private copy of the public payload and the source component name (or `null`), the call returns an unsubscribe function, each element holds at most 32 subscriptions and Alpine cleanup removes all of them. Names use the Live event grammar; an invalid name, a non-function callback or a detached element throws.

```html
<div
  nv:ignore=""
  x-data="{ last: null }"
  x-init="$live.on('saved', (payload) => (last = payload))"
>
  <span x-text="last?.title"></span>
</div>
```

`$live.state` and `$live.entangle` are intentionally not provided. A whole-state proxy would blur which fields are public, writable and server-validated, and two-way entanglement would let Alpine reactivity write drafts outside the client's model scheduler and invalid-input rules. Read with `$live.get` (reactive), stage with `$live.set` and commit with `$live.call`, or use an owned `nv:model` control. Arbitrary mixed DOM ownership, teleport handling and the full Live directive set are not implemented here. No expression evaluator is added by Nestvexa. Templates are trusted application code.

## Public API

Exports: `installLiveAlpine`, `startLiveAlpine`, `adoptLiveAlpine`, `hostAlpine`, and the types `AlpineHost`, `AlpineMagicUtilities`, `LiveClientBridge`, `LiveMagic`, `AlpineRuntime`, `ManagedLiveClient`, `StartLiveAlpineOptions`, `AdoptLiveAlpineOptions` and `LiveAlpineApplication`. Delegated startup defaults to the current document. There are no import-time startup side effects. ESM; the `default` export condition lets bundlers and `require(esm)` resolve it, with no dual-module identity promise.

See the [default starter](../../examples/starter-live/README.md), [Live counter](../../examples/live-counter/README.md), [client package](../client/README.md), [CSP guide](../../docs/guides/csp.md), [security policy](../../SECURITY.md) and [status](../../docs/implementation/STATUS.md).

## Status and limits

Status: **Partial**. `$live.call/get/set/dispatch/on`, explicit and delegated startup and host-Alpine adoption work and are tested with the real CSP Alpine runtime in Chromium.

- Only Alpine 3.17.x is accepted and tested; broader host-Alpine compatibility is not established (BROW-005).
- `$live.state` and `$live.entangle` are intentionally not provided (see above) (BROW-014). `$live.dispatch` has no dedicated test, and `$live.on` is covered by unit tests only, not by a real-Alpine browser test.
- Alpine markup must sit in an `nv:ignore` subtree; arbitrary mixed DOM ownership, teleports and the full Live directive set are not handled.
- An Alpine instance already started before adoption cannot be detected through public APIs; adopt or start before the host starts Alpine.
- Cross-copy or pre-existing unrelated `$live` plugin detection is not guaranteed.

## Testing

```sh
pnpm --filter @nestvexa/alpine test
```

Runs `tests/alpine.test.ts` (facade, cleanup, ownership, `$live.on`) and `tests/alpine-start.test.ts` (startup and adoption in Chromium with the actual CSP runtime/client and controlled transport fixtures); build first with `pnpm --filter @nestvexa/alpine... build` because the tests import `dist`. Browser examples that exercise real server requests (for example `tests/browser/live.spec.ts`) run through the root Playwright config.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
