# Browser runtime evidence, round 4

Branch `worktree-agent-a0b11f45050b6e8c0`. All browser evidence runs against a
real Nest server, the new [`examples/browser-lab`](../../../examples/browser-lab/README.md)
(port 3860, default `{{nvScripts}}` boot module, bundled CSP Alpine 3.17,
strict CSP), in Chromium, Firefox and WebKit.

## BROW-021 / DIR-011: navigation

Implemented and fixed in `packages/client/src/navigation.ts`:

- Forward now restores scroll as well as Back. The controller keys history
  entries (`nestvexaKey`), remembers up to 64 positions and owns
  `history.scrollRestoration = 'manual'` while mounted (restored on dispose).
  Before, only the entry being left was updated, so Forward always went to the top.
- Named and Open Graph `<meta>` elements follow the incoming document. Before,
  only `meta[name=description]` was copied, and only when both documents had it.
  `viewport` stays with the shell.
- The clicked link's fragment survives same-origin redirects (fetch drops it).
- Back/Forward fallbacks use `location.replace`, so the history stack keeps
  its length. New visits still use `location.assign`.
- Swapped components register synchronously in `onNavigated`
  (`packages/client/src/index.ts`). Alpine's mutation observer predates
  Live's, so `$live` reads on swapped pages used to run before registration.

Tests: `tests/browser/navigation.spec.ts` covers swaps without a reload,
history, title and metadata; scroll on Back/Forward and fragments; redirects;
full-load fallback for a different asset set, `dir`, non-HTML, 404 and native
links; traversal fallback replacing the entry; dirty-draft confirmation
(cancel keeps the page and drafts, accept leaves); `aria-busy` progress; and a
slower earlier visit that finishes last being ignored.
Docs: `docs/reference/nv-navigate.md`, `packages/client/README.md`.
Gap: none known in this scope. Back/Forward does not ask for confirmation
because browsers cannot cancel it; this is documented.

## BROW-018: prefetch

The current page is never prefetched. Any committed Live request (action or
`$sync`) clears the prefetch cache through the new
`NavigationController.invalidate()`. Tests in `navigation.spec.ts` prove a
GET-only prefetch with navigation headers; one reuse (the server render count
does not change); expiry after 10s; invalidation after a commit; and that a
stale prefetched response is not applied after a newer visit.
Docs: `docs/reference/nv-navigate.md` (Prefetch section).

## BROW-014: Alpine `$live`

`packages/alpine/src/index.ts`:

- `$live.state` is a read-only reactive Proxy over public state, with the same
  values as `$live.get`, local drafts included. Writes, deletes and defines
  throw. Internal probe keys read as `undefined`.
- `$live.entangle(name)` binds one primitive field to `x-data` through
  `Alpine.interceptor` and element-bound `effect`. Alpine writes stage a draft
  (like `$live.set`), committed values flow back without an echo, and
  non-primitive values are reverted and throw.
- The `startLiveAlpine`/`adoptLiveAlpine` bootstrap calls
  `Alpine.destroyTree(document.body)` on `nestvexa:navigate`. Without this,
  first-render trees kept their `$live.on` window listeners after a body swap.
  The Chromium heap check found this leak.

Tests: `tests/alpine.test.ts` (3 new unit tests) and
`tests/browser/alpine-bridge.spec.ts`, which uses the real CSP Alpine and checks
`$live.dispatch` → server `@OnEvent`, a server event → `$live.on` with its
source, unsubscribe, the reactive `$live.state`, the read-only rejection and
the entangle round trip. It runs on a loaded page and on pages reached through
`nv:navigate` and Back/Forward.
Docs: `packages/alpine/README.md` (with a CSP-safe `Alpine.data` example for `$live.on`).
Gap: hosts that call `installLiveAlpine` directly with `nv:navigate` must call
`destroyTree` themselves (documented). `entangle` deliberately bypasses the
`nv:model` debounce/invalid-input scheduler.

## PROT-020 / BROW-013: reorder, reconnection, leaks

`tests/browser/runtime-resilience.spec.ts`:

- A captured authentic stale reply, delivered after a newer one, is rejected
  (revision check) and not applied.
- Requests from one component are serialized, so their replies cannot be
  reordered.
- Independent components apply their own replies in any arrival order.
- A late reply for a component that navigation removed is discarded.
- `nv:poll` pauses in a hidden tab and resumes when the tab is visible again.
- Network loss: offline state shows, nothing is sent, and recovery is clean.
- Progressive fallback (new client behaviour): a suspended root gets
  `data-nv-suspended`, and a suspended `nv:submit` form with an explicit
  `action` submits natively to the host route. The failed Live request is
  never resent. A healthy component still prevents native submit.
  Docs: `docs/guides/offline.md#full-page-fallback-for-a-suspended-component`.

`tests/browser/lifecycle-leaks.spec.ts`:

- In all browsers, instrumented counts of window/document listeners, timers,
  observers and `nestvexa:event` subscriptions return to the same values
  across repeated swaps of a 12-component page (poll timer, intersection
  observer and Alpine `$live.on` subtree in each). `app.dispose()` releases
  every timer and Live subscription.
- In Chromium only (it is skipped at runtime on Firefox and WebKit), the CDP
  heap check measures `Nodes`, `JSEventListeners` and `JSHeapUsedSize` after
  forced GC across 10 more cycles, and `Runtime.queryObjects` finds no
  detached `.cell` roots.

Gap: the remaining PROT-020 items (property-based serializer fuzzing, owned by
another engineer; replay/tampering; concurrent users; auth/tenant swapping)
and the wider BROW-013 morph/input matrix are outside this round. Alpine has
no public stop API, so the Alpine-owned handles left after `dispose()` are
not counted.

## Coordinator item: resync on `409 STALE_REVISION`

The realtime agent's trace: a proxy dropped the reply to a committed `$sync`,
so the client stayed one revision behind. Its next request got
`409 STALE_REVISION`, whose documented recovery is `resync`, but the client
suspended the component. Two things blocked a fix inside the client alone.
First, the browser never parses error bodies, so a 409 `STALE_REVISION` looks
the same as `COMPONENT_BUSY`, `STATE_SCHEMA_CHANGED` and the other 409 codes.
Second, every request, `$sync` included, is checked against the client's stale
revision, so a plain resync would fail too. The fix spans both packages:

- `@nestvexa/live` (`live.module.ts`): a `LiveRecoveryInterceptor`, prepended
  on every generated Live controller, sets `x-nestvexa-recovery: resync` on
  `STALE_REVISION` replies only.
- `@nestvexa/live` (`runtime.ts` admission): a `$sync` with
  `x-nestvexa-resync: 1` and empty `updates` targets the current revision of
  the caller's own snapshot. Snapshot binding, origin, CSRF and authorization
  are unchanged and still checked first. A resync with any update, any other
  header value or on an action route is `400 INVALID_REQUEST`. It writes
  nothing from the client and runs no action.
- `@nestvexa/client` (`transport.ts`, `index.ts`): a hinted 409 rejects the
  call (never replayed) and does not suspend. It queues one resync, which
  sends no drafts and accepts any newer revision. Local drafts stay dirty and
  go with the next request. Stale requests queued behind the first share that
  resync. A resync that is itself stale suspends, so there is no loop. The
  hint is ignored on any status other than 409.

Tests:

- `tests/live-stale-revision.test.ts` (Express and Fastify): the hint on stale
  actions and `$sync`, and no hint on CSRF or 404 failures; the resync renders
  the current revision without running the action; negative cases (updates,
  action route, bad header value, CSRF first, state unchanged).
- `tests/client-transport-lifecycle.test.ts` (Chromium, controlled fetch):
  one shared resync, no replay, draft kept and sent at the new revision; a
  stale resync suspends; the hint on a 500 is ignored.
- `tests/browser/runtime-resilience.spec.ts`: a real proxy drop of a
  committed `$sync` on the browser-lab server, then a refused increment,
  exactly one resync, the committed value shown, no suspension and no replay.
  The lab counter gained a `nv:model.live` `echo` field for this.

Docs: `docs/guides/offline.md`, `docs/reference/live-protocol.md`,
`packages/client/README.md`; changeset `stale-revision-resync`
(live minor, client patch).

## Verification on this host

The host was badly overloaded throughout: CPU at 100%, 235–650 MB of RAM free
and dozens of other node processes. A blank data URL took 18–24 s to load in
Firefox, a trivial click took 48 s in WebKit, and Firefox logged
`RenderCompositorSWGL failed mapping default framebuffer` crashes.

- Chromium, all four specs: 21 of 22 passed. The leak test then failed only on
  the 30 s default timeout (it ran 51 s), so it now sets its own
  `test.setTimeout(120_000)`.
- Firefox: `runtime-resilience` and `alpine-bridge` passed 10 of 10 at
  `--workers=1 --timeout=240000`. With the default timeout, pages timed out
  while being set up. `navigation` and `lifecycle-leaks` passed in the
  three-browser run.
- WebKit, serial with an uncommitted 240 s test and 60 s expect timeout:
  18 passed, 3 failed, 1 skipped (the Chromium-only heap test).
  - Two failures stalled in Playwright's "visible, enabled and stable" wait. A
    diagnostic script against the same server measured 0 animation frames in
    4 s, but its click still worked after 80 s and the entangle round trip
    completed ("Hello!" back from the server).
  - The prefetch test failed because WebKit took longer than the 10 s prefetch
    lifetime between hover and click, so the page was fetched again. That is
    the expected expiry behaviour on a starved host.
- After main was merged and load dropped, all three of those WebKit tests
  passed on rerun (`alpine-bridge` loaded page, prefetch, and the
  many-component leak test). The new `STALE_REVISION` resync browser test
  passed in Chromium, Firefox and WebKit.
- Every spec has passed in every browser at least once. No single
  uninterrupted three-browser run of all four specs completed on this host,
  so the coordinator should do one on a normally loaded machine before
  closing the ledger rows.

## Merge notes

- New workspace example `@nestvexa/example-browser-lab` (lockfile updated).
- A root `playwright.config.ts` webServer entry for port 3860 is added.
- Changesets: `browser-round4-alpine` (alpine minor),
  `browser-round4-fallback` (client minor), `browser-round4-navigation`
  (client patch), `stale-revision-resync` (live minor, client patch).
- `tests/live-stale-revision.test.ts` joins `test:integration` and
  `test:security` in the root `package.json`.
- Main is merged in twice (last at `e93af58`). Kept: `retries`/`forbidOnly`
  and all of main's 40 webServer entries, plus the browser-lab one on 3860.
  Conflicts resolved:
  - Test-group lists in `package.json`: main's lists, plus
    `live-stale-revision`.
  - `packages/client/README.md`: main's new Status/Testing/Maintainers
    sections, plus this branch's transport and navigation paragraphs.
  - `packages/alpine/README.md`: main's structure. The BROW-014 status bullet
    there ("state/entangle not provided, dispatch/on untested") is updated to
    match this branch.
    The `STALE_REVISION` change touches `packages/live/src/live.module.ts` and
    `runtime.ts` admission; expect small conflicts if another branch edits the
    generated controller or `admitUntraced`.
