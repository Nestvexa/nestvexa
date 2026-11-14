# @nestvexa/client

Small experimental browser-only Live client: it discovers server-rendered Live roots, wires `nv:*` directives, sends protected actions and morphs the authoritative HTML the server returns. Import `createLiveClient` and explicitly call `mount()`; `dispose()` removes listeners, observers and aborts in-flight requests. Imports do not touch DOM globals. No Nest or frontend framework dependencies are included.

```js
import { createLiveClient } from '@nestvexa/client';
const client = createLiveClient({
  requestTimeoutMs: 30_000,
  onError(error) {
    console.error(error.message);
  },
});
client.mount();
```

## Installation and role

The package is unpublished: install the local tarballs produced by `pnpm build && pnpm test:pack`. Future registry syntax: `npm install @nestvexa/client`, `pnpm add @nestvexa/client` or `yarn add @nestvexa/client`. It has no dependencies or peers. The `nestvexa` umbrella depends on it and serves its canonical bundle through the integrated asset service with the default Alpine bootstrap, so default applications do not import it directly; the [client asset guide](../../docs/guides/client-assets.md) covers standalone hosting. The server half of the protocol is `@nestvexa/live`.

ESM output requires modern browsers with fetch, ReadableStream, TextDecoder, AbortController, crypto.randomUUID and MutationObserver. The local matrix includes Chromium, Firefox and WebKit; consult the latest report for pass/fail outcomes. Public exports are `createLiveClient`, the `LiveClient`/`LiveClientOptions` types, `LiveClientError`/`LiveHttpError`, and the per-directive parsers used by tests and tooling (see `src/index.ts`).

## Behavior reference

[Sorting](../../docs/reference/nv-sort.md) submits bounded item-order proposals
through the normal protected action queue. `maxSortLists` defaults to 64 (1–256).
Only server-rendered HTML commits order. `call(element, action, input)` captures
a detached JSON input at enqueue: at most 16 KiB, depth 8 and 1,000 nodes, without
invoking getters or freezing caller objects. Combined mutation requests are
limited to 64 KiB before network dispatch. Server validation remains authoritative.

[Read-only text streams](../../docs/reference/nv-stream.md) use a trusted `streams`
map and explicit `startStream(target)` / `cancelStream(target)` calls. They never
parse HTML or automatically retry. See the host route, authorization and provider
cancellation contract in [the streaming guide](../../docs/guides/text-streams.md).

[Poll](../../docs/reference/nv-poll.md), [intersect](../../docs/reference/nv-intersect.md),
[offline](../../docs/reference/nv-offline.md), [current](../../docs/reference/nv-current.md)
and [transition](../../docs/reference/nv-transition.md) directives are implemented.
`maxObservers` bounds polling/intersection bindings (default 256, integer 1–1,000).
They invoke normal protected actions; client visibility never grants permission.
`client.transition(element, 'enter' | 'leave')` lets a host await its CSS phase.
Retained `nv:show`/`nv:dirty` changes animate; synchronous morph removals do not
delay teardown for an exit animation. Choose distinct URL-state aliases for
independent components in one document; the query string is page-wide.

`nv:init="load"` schedules one eager registered-action attempt per component
registration after the synchronous mounting turn. Manual entries can configure
`maxInitializations` (default 64, integer 1–1,000). Ownership changes and disposal
cancel undispatched work; failures never retry automatically. See the
[initialization reference](../../docs/reference/nv-init.md) for replacement,
remounting and capacity. `.visible` waits for viewport intersection; `.idle` uses an idle callback with a bounded fallback. Server-rendered placeholders that load later are lazy components (`@LiveComponent({ lazy })`, see [nested components](../../docs/guides/nested-components.md#lazy-components)).

`nv:confirm` adds plain-text native confirmation to event actions. Advanced manual
entries can supply `confirm: LiveConfirm` and `confirmationTimeoutMs`; the exported
`LiveConfirmation` context includes an abort signal. See [the individual directive
reference](../../docs/reference/nv-confirm.md) for limits, cancellation, keyboard
and accessibility integration, `.once` semantics and security boundaries.

Opt-in `onDiagnostic` emits frozen, redacted queue/request/morph timing samples, with isolated sink failures and no retained buffer. Collection is disabled by default; see [browser timing diagnostics](../../docs/guides/client-diagnostics.md). The protocol and mutation/retry policy are unchanged.

Native multiple selects support bounded flat array models with strict option catalogs, ordered dirty equality, shared aliases and reset. See [array behavior and limits](../../docs/guides/multiple-select.md). Checkbox groups are covered under nested models below; file inputs use `nv:upload` instead of `nv:model`, and generic programmatic array setters remain unsupported.

Retained local editable hosts preserve a single native caret or forward/backward selection through keyed moves, to the [documented ownership and node-identity limits](../../docs/guides/focus-restoration.md#local-editable-selection). Range restoration precedes focus so host focus handlers keep their final choice. This does not expose editor HTML as model state or add rich-text form support.

Visibility/dirty bindings, loading visibility and reconciliation now share temporary focusability ownership, including shared ancestor leases and disposal cleanup. See the [focus guide](../../docs/guides/focus-restoration.md) for the installed-module boundary and remaining gaps.

Post-morph [focus restoration](../../docs/guides/focus-restoration.md) falls back to an available component root when a focused control becomes unavailable, preserves host-selected focus, and releases its temporary tabindex/listener on blur, release or disposal. Existing root focus policy stays host-owned; complete keyboard/screen-reader acceptance remains open.

Implemented directives: init, confirm, click, submit, keydown, model, loading/target, poll, intersect, offline, current, transition, replace, ignore, text, show, bind, dirty, cloak and ref. Event modifiers support prevent/stop/self/once, keyboard/system filters, debounce and leading throttle; see the [exact grammar](../../docs/reference/directives.md). Unsupported modifiers/directives are rejected explicitly. Expressions are not evaluated. Further directives (sort, stream, navigate, optimistic, upload and URL state) are listed in the [directive reference](../../docs/reference/directives.md). The optional [Alpine adapter](../alpine/README.md) supplies `$live.call/get/set/dispatch/on` inside an ignored ownership boundary. The full master directive matrix remains unmet.

`nv:ignore.self=""` retains an inner wrapper's current attributes while its children remain Live-owned. Classes, style, ARIA and IDs stay with the wrapper; use a stable `data-nv-key` if a widget changes its ID. Same-node `nv:*` configuration is fixed across retained updates: change the key or replace an ancestor to reconfigure it. Attribute/model/loading/replacement effects must target children instead. Native input/textarea/select/option/optgroup elements, editable wrappers and Live/island roots explicitly reject `.self`. Ordinary↔self ownership changes replace the wrapper and clean up removed children; an existing whole-ignore subtree remains opaque until key/ancestor replacement. Effective incoming attributes are projected before preview validation and native form-owner reconciliation. `.self` does not grant Alpine `$live` isolation or framework ownership of its children. See the [wrapper ownership guide](../../docs/guides/ignore-self.md) for exact restrictions and failure behavior.

`nv:model` defaults to deferred local edits sent with the next action. `.live` synchronizes after a trailing 150 ms debounce; `.blur` waits for focusout, and `.change`/`.lazy` wait for native change. Explicit `.debounce.300ms` and `.throttle.500ms` imply live mode; bare timers use 250 ms, with whole-number intervals from 1 to 60,000 ms. Throttle sends on the leading edge without a trailing call. A mode cannot combine blur/change/defer with a timer. `.number` accepts complete finite decimals; `.boolean` accepts only true/false/1/0 values. Conflicting, duplicate and unknown modifiers are rejected.

Models support text-like, number, checkbox and radio inputs, textareas and single/multiple selects. Unchecked radios emit no update; checkboxes produce booleans. Empty numeric controls are invalid. Multiple selects yield unique flat arrays (256 items, 1,024 options, 16,384 UTF-8 JSON bytes), with strict per-option conversion and alias projection. File inputs are not models (use `nv:upload`); checkbox groups and dotted paths are described under nested models below. IME composition waits for the final input. Invalid conversions block component requests until corrected or the invalid control is removed. Timers are canceled on ownership/configuration changes, removal and disposal; an ordinary action also cancels pending model timers. Models use the protected internal `_sync` endpoint, requiring explicit host `$sync` authorization and writable server state. Method-specific action guards do not govern synchronization: use component/global guards or the host policy for every-write authorization.

Native reset buttons and `HTMLFormElement.reset()` reconcile owned model drafts with the resulting control values, clear validly reset local conversion/composition state and cancel affected field model timers. Reset does not send an action or `_sync`; it records newer field versions so a pending response cannot restore a discarded edit. Canceled resets leave drafts and timers unchanged. Reconciliation uses actual form ownership, including disabled and externally associated owned controls, while respecting ignored/island/client boundaries. Invalid numeric defaults, unselected model-radio defaults, conflicting field aliases and cross-owner radio groups cancel the reset with an explicit error. Synthetic `dispatchEvent('reset')` does not execute native reset and is ignored. See the [native reset guide](../../docs/guides/form-reset.md) for timing, alias behavior, stale-plan cleanup and unsupported states. This does not implement the complete forms package or change server authorization.

Loading presentation tracks queued and executing requests per action. `nv:loading=""` shows pending content; `.remove` hides it while pending. `.class="working"` and `.attr="disabled"` apply reversible effects; adding `.remove` removes the named class/attribute while pending. `nv:target="save,$sync"` limits an effect to matching requests; without a target, any pending action or synchronization activates it. The grammar allows up to 16 unique simple class tokens or action targets, and only `disabled`, `readonly`, `aria-disabled`, `aria-busy` attributes. Captured class/attribute values are restored, so a server-disabled control remains disabled after completion. Arbitrary attributes/classes are not supported; `.delay` is described below. Conflicting property owners, root visibility and root `aria-busy` loading effects are rejected. These are presentation controls, not authorization.

`nv:replace=""` retains its owned inner wrapper while replacing its children; wrapper attributes still follow server markup. `nv:replace.self=""` replaces the element as well. The incoming fragment chooses the mode. A component root or an ignored/nested/island boundary cannot itself carry replacement; an explicitly replaced ancestor may remove such descendants. Native controls and void elements require `.self`. Replacement resets native/file selections and local Alpine/widget state; it deliberately discards local edits when all original controls for that field are removed. Normal keyed morphing retains ownership boundaries.

A component root has one active client owner. A second client cannot attach competing listeners; dispose the owner before transferring it. The client records the raw values of seven server-created marker attributes: component ID, name, endpoint, CSRF token, snapshot, revision and public state. External changes invalidate that registration once, abort its work and require explicit disposal/remounting after the host reconciles it. Its own successful response writes remain valid. This is browser consistency checking, not a signature or authorization mechanism. Server identity, CSRF, ownership and revision checks remain necessary. Moving a root under an island releases ownership without claiming that DOM removal occurred; putting `nv:ignore` on a Live root is invalid. Independent Live roots under an ignored ancestor remain separate registrations.

`client.call(element, action)` returns the queued request promise. `get(element, field)` returns detached state or local edits. `set(element, field, primitive)` updates local state until submitted. `refs(element)` resolves owned references from the current DOM. Server authorization and writable-state checks always apply.

Requests are serialized per component, capped at 16 pending operations, sent same-origin with host CSRF token, and not retried automatically except for server-declared idempotent actions (see Transport below). Duplicate submits are suppressed. Response identity/request/revision checks precede DOM updates. Keyed nodes retain identity unless incoming markup explicitly replaces them; nested live/ignored/island roots are ownership boundaries. Focus/caret and newer input edits are preserved where tested; removing the focused control moves focus to the retained component root.

`requestTimeoutMs` accepts an integer from 1 through 300,000; the default is 30,000 ms. Each deadline starts when its request is dispatched and covers fetch plus body consumption, excluding time in the component queue. The client counts the response body's bytes as they arrive, rejecting more than 2,097,152 bytes before decoding the complete text. It requires `application/json` (parameters allowed) and valid UTF-8. A declared length cannot bypass the streaming limit. This deadline does not cancel server business work or preempt synchronous JavaScript.

An uncertain network, deadline, response/protocol or rendering failure suspends further transport for that component and its nested owned roots. Two transport failures are not uncertain and leave the component usable: a request not sent because `navigator.onLine` was `false` (reported as `NETWORK`), and a `$sync` refresh that got no response (no action method runs; a committed one is caught by the next revision check). A `409 STALE_REVISION` (marked `x-nestvexa-recovery: resync`; nothing ran) also leaves it usable. The call rejects and is never replayed; calls already queued behind it were issued against the refused view, so they are dropped unsent (rejected with `ABORTED`, not reported as page errors). The client sends one fresh resync (`$sync` with `x-nestvexa-resync: 1` and no drafts) that adopts the server's current revision and state. A resync that is itself stale suspends instead of looping ([details](../../docs/guides/offline.md)). A `409` with `x-nestvexa-reload: asset-version` dispatches a cancelable window `nestvexa:reload` event and then reloads the page. The registration, local drafts and `get`/`set` access remain available. Suspended roots get a `data-nv-suspended` attribute for a reload affordance, and a suspended `nv:submit` form with an explicit `action` attribute submits natively to that host route (a fresh full-page request, never a resend of the failed call); other enhanced form submission remains prevented ([full-page fallback](../../docs/guides/offline.md#full-page-fallback-for-a-suspended-component)). Pending requests are aborted, queued calls reject the stored cause, loading baselines restore and component `aria-busy` becomes false. Independent sibling components remain separate. Errors use stable `LiveClientError` codes including `NETWORK`, `TIMEOUT`, `RESPONSE` and `HTTP`; exported `LiveHttpError` adds a numeric `status`. Native fetch exception text and HTTP error bodies are not exposed by the transport. The HTTP rejection allowlist permits explicit correction after 400/401/403/404/405/413/415/422/429; it never triggers an automatic retry (only declared idempotent actions are resent, see Transport below) or guarantees a business rollback. Other HTTP outcomes suspend transport.

Recover by reloading or obtaining trusted authoritative server state, then disposing and explicitly mounting against reconciled markup. Simply clearing the browser failure or reusing old markers cannot prove that a timed-out action did not commit. Removal/disposal cancellation settles affected `call()` promises without applying a late response; a resolved cancellation is not a business-success acknowledgement. See the [request lifecycle guide](../../docs/guides/request-lifecycle.md) for recovery, errors and exact bounds. Full transport/fault/platform acceptance remains open.

Ordinary morphing merges native values with incoming server defaults. Unbound text/textarea edits, checkbox/radio choices and single/multiple-select selections remain local while their server defaults stay unchanged; a changed default is authoritative. These unbound values are not added to Live state or request updates. Textarea reset defaults are updated, option keys preserve duplicate-value identity, and file selections survive ordinary reconciliation without implying upload support. Compatible newer model drafts survive only while an original matching field/cast/control type remains; changes clear hidden stale edits. Bound multiple selects instead project their current array membership; unavailable newer values remain subject to server validation. Editable content stays local while `contenteditable=false` content follows the server. Explicit replacement intentionally resets local state. Use valid forms and unique radio names or distinct forms per component; shared native radio groups across owners are not a proven isolation boundary. See the [native control and ownership guide](../../docs/guides/native-controls.md) for rules, reset options and limits. The full native-input/teleport/framework lifecycle matrix remains open.

Render only trusted application templates. The client rejects active document tags, non-HTML namespaces and inline event handlers in updates; this is defense in depth, not a general HTML sanitizer. Use server escaping and a restrictive CSP. Both HTML sinks (response fragments and `nv:navigate` documents) go through a module-private Trusted Types policy named `nestvexa`, so pages enforcing `require-trusted-types-for 'script'` can allow it with `trusted-types nestvexa`; see the [CSP guide](../../docs/guides/csp.md).

`nv:loading` accepts a trailing `.delay[.Nms]` (default 200 ms, 1–10,000 ms) so quick work never flashes an indicator ([reference](../../docs/reference/nv-loading.md)). `nv:click`/`nv:keydown` accept `.window`/`.document` for global bindings that exist only while the declaring element is owned and accept trusted events only ([reference](../../docs/reference/nv-events.md)). A suspended component keeps `nv:offline` registered so the hint reflects connectivity, not every failure. The [directive matrix](../../docs/reference/directive-matrix.md) lists the tested combinations, edge cases, leak checks and gaps. Errors go to `onError` or `nestvexa:error`. Bubbling, noncancelable `nestvexa:before-remove` and `nestvexa:after-insert` events identify each outer removed/inserted element subtree; descendants are included rather than notified individually. Retained keyed moves emit neither event. Removal cancels client timers/listeners and aborts nested Live requests before releasing ownership. `nestvexa:updated` follows Live reconciliation/discovery; asynchronous third-party initialization remains the host's responsibility. Framework islands are a separate package ([`@nestvexa/islands`](../islands/README.md)) and server-mounted children are described below.

See the [cookie-backed example](../../examples/live-counter/README.md), the [directive lab](../../examples/directive-lab/README.md) and the [protocol](../../docs/guides/live-protocol.md).

TypeScript emits documented declarations; esbuild creates one minified canonical ESM bundle with linked original-source maps. Private per-module JavaScript is used only by implementation tests and is excluded from published files and served assets. The 48 KiB (49,152-byte) gzip budget checked by `pnpm size:check` measures the complete public custom runtime bundle. See [the build decision](../../docs/adr/0015-production-client-bundle.md) and the [budget revision](../../docs/adr/0020-client-budget-revision.md). The estimate excludes Alpine and maps and is not observed HTTP transfer compression. Deployed map exposure remains a host policy.

## Nested components and events

Server-mounted child roots are independent components. Empty `data-nv-stub` roots keep the existing child DOM; `data-nv-refresh` roots replace it; unmatched stubs are rejected before any DOM change. Responses may carry bounded `events` (delivered to `@OnEvent` listener actions and as a window `nestvexa:event`) and an application-relative `redirect`. `client.dispatch(name, payload)` delivers browser events. Lazy roots (`data-nv-lazy`) load through `$sync`. See the [nested components guide](../../docs/guides/nested-components.md).

## Nested paths, checkbox groups and restored drafts

`nv:model`, `nv:text`, `nv:show`, `nv:bind` and `nv:dirty` accept dotted paths (`address.city`, at most eight identifier segments). A nested draft is sent as its whole top-level field and the server accepts it only through `@State({ writable: ['city'] })`. Checkboxes modelling array state form value groups; file inputs use `nv:upload`; `contenteditable` is not modelled. Values the browser restores before mount become drafts announced by `nestvexa:restored`. See [nested models](../../docs/guides/nested-models.md).

## Transport: bundling, retries, negotiation, progress

A queued `$sync` folds into a request of the same component that has not started. Only server-declared idempotent actions (`data-nv-idempotent`) are resent, with the same `requestId`, after drops, timeouts and `409/429/502/503/504` (two resends, full jitter). Another advertised protocol major or a `426` reports `PROTOCOL`. Each root dispatches `nestvexa:request` (`start`/`retry`/`end`) events without payloads. `createLiveClient({ development: true })` enables `inspect()` (names, never values or tokens) and console warnings. See [client transport](../../docs/guides/client-transport.md) and [diagnostics](../../docs/guides/client-diagnostics.md).

## Navigation and optimistic updates

`nv:navigate` links swap same-origin documents with full-load fallback, scroll restoration on Back and Forward, title/metadata updates, dirty-draft confirmation and explicit hover prefetch that committed Live requests invalidate ([reference](../../docs/reference/nv-navigate.md)); `client.navigate(url)` visits programmatically. `nv:optimistic.toggle|set|increment|decrement` projects display bindings until an action settles and emits `nestvexa:rollback` on failure ([reference](../../docs/reference/nv-optimistic.md)). Responses with `download` trigger a single-use attachment.

## Status and limits

Status: **Partial**. The directives, models, transport, morphing and ownership rules above work and are tested in unit, three-browser matrix and real-server browser suites; the full master directive matrix is not complete.

- HTML-fragment streaming is not supported; `nv:stream` is text only (DIR-016).
- `nv:sort` supports vertical same-list moves only; touch, grid and cross-list movement are unsupported (DIR-017).
- No teleport support (portal targets belong in `nv:ignore`); complete external-widget and renderer-specific island teardown acceptance remains open (BROW-010, DIR-019, DIR-020).
- Manual screen-reader (NVDA/VoiceOver) checks have not been run; layout-shift measurement runs in Chromium only (BROW-008).
- Restored-draft detection is emulated before mount; a real reload-restoration run is not automated (DIR-008).
- Distributed fault and long-memory acceptance of the transport remain open; streams and `nv:navigate` GETs are not retried (BROW-006, BROW-020).
- One canonical bundle; no code splitting (BROW-004).

## Testing

```sh
pnpm --filter @nestvexa/client test
```

Runs `tests/client.test.ts` and `tests/client-*.test.ts` (directive grammar, models, transport, morphing, focus, ownership, CSP and the three-browser directive matrix in `tests/client-directive-combinations.test.ts`); build first with `pnpm --filter @nestvexa/client... build` because the tests import `dist`. Real-server scenarios such as `tests/browser/directive-lab.spec.ts`, `tests/browser/live.spec.ts` and `tests/browser/nesting.spec.ts` run through the root Playwright config.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
