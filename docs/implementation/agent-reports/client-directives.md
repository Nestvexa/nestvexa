# Agent report: browser runtime and `nv:*` directives (BROW, DIR)

Branch `worktree-agent-aeaa4b97f4257c91d`. Scope: `packages/client` (not `realtime.ts`), `packages/alpine`, tests, docs and a new example. `packages/live` was not modified.

## Implementation summary

| Change                                                                                                                                                                                                                                                                                                                                                                       | Files                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `nv:loading[.class\|.attr][.remove].delay[.Nms]` (default 200ms, 1–10000ms, one delay per element, rejected on `nv:offline`)                                                                                                                                                                                                                                                 | `packages/client/src/loading.ts`, `presentation.ts` |
| `.window` / `.document` scopes for `nv:click`/`nv:keydown`: listener on the owning window/document, trusted events only, active only while the declaring element is owned by a healthy registration, released on removal/suspension/disposal; `.self`, `.stop`, both scopes and `nv:submit` scopes rejected; delegated path skips scoped declarations (no double invocation) | `events.ts`, `listeners.ts`, `index.ts`             |
| Trusted Types: both HTML sinks (fragment `<template>` and `nv:navigate` `DOMParser`) go through a lazily created module-private `nestvexa` policy; a page policy excluding it fails closed                                                                                                                                                                                   | `grammar.ts`, `index.ts`, `navigation.ts`           |
| Bug fix: a suspended component keeps presentation registrations, so `nv:offline` no longer reverts to server markup (announcing a false outage) after a 500/protocol error                                                                                                                                                                                                   | `index.ts` (`cancelSubtree(node, suspended)`)       |
| Alpine `$live.on(name, callback)` (payload copy per subscriber, unsubscribe, 32 bound, automatic cleanup); `$live.state`/`$live.entangle` documented as intentionally not provided                                                                                                                                                                                           | `packages/alpine/src/index.ts`                      |
| Client bundle: 45,248 gzip bytes (budget 49,152; +516 bytes from the start of this work, measured by `pnpm size:check`)                                                                                                                                                                                                                                                      | —                                                   |

## New tests

- `tests/client-directive-grammar.test.ts` (unit + security group, 194 tests): oracle-checked grammar for every directive; all 256 flag subsets × 3 keys × 5 schedulers × 3 scopes × 3 event kinds in two orders (>10k accepted, >10k rejected); every model mode × cast × timer in all rotations; loading/offline effect × remove × delay; explicit rejection tables and expression/`__proto__`/URL values.
- `tests/client-directive-combinations.test.ts` (integration, 79 rows): real Chromium + canonical bundle + in-page fake server (`tests/support/live-matrix.ts`).
- `tests/client-runtime-resilience.test.ts` (integration, 20 tests): focus/selection/scroll, accessibility, error recovery, CDP leak checks.
- `tests/client-csp.test.ts` (security, 3 tests): strict CSP + enforced Trusted Types against a real HTTP endpoint, fail-closed denial, static bundle scan.
- `tests/browser/directive-lab.spec.ts` (7 scenarios × Chromium/Firefox/WebKit) against `examples/directive-lab` (port 3360).
- `tests/alpine.test.ts`: two `$live.on` tests. `tests/client-events.test.ts`, `tests/client-loading.test.ts`: rejection tables updated for the new grammar.

## Per ledger row

**BROW-004** (one-time init, idempotent mount/unmount, footprint) — Evidence added: 50 mount/dispose cycles on one client plus 50 fresh clients produce an identical listener set per mount and leave the page listener count at its baseline (`client-runtime-resilience`, "releases every page listener…"). Footprint measured: 45,248 gzip bytes single bundle. Gap: code splitting is not implemented (one canonical bundle by ADR 0015/0020); recommend recording as a deliberate decision.

**BROW-005** (Alpine adapter) — Added `$live.on` with cleanup; unit tests. Gap unchanged: broader host-Alpine compatibility and automatic default distribution bootstrap were not in this scope.

**BROW-006** (delegation, scheduler, debounce/throttle, error/retry, diagnostics) — Combination rows prove delegation, debounce/throttle (click, keydown, submit, model), per-action queue counts and error codes. Error recovery: 500 suspends, 422 stays usable, network → `NETWORK` + offline hint + recovery after remount, deadline → `TIMEOUT`, malformed/stale → `RESPONSE`, queued work rejected. Gap: request bundling/retry with jitter, version negotiation and distributed fault acceptance remain open.

**BROW-007** (SSR hydration, CSP-safe invocation, SPA cleanup) — CSP: `client-csp.test.ts` (no violation through morph, model sync, cloak, `nv:navigate` under `require-trusted-types-for 'script'`; fail-closed when `nestvexa` is not allowed; no eval/new Function/string timers/outerHTML/document.write in the bundle) and the directive lab in three browsers with an empty `securitypolicyviolation` log. SPA cleanup: `nv:navigate` swap and return keeps one client (lab). Recommend Done for the CSP clause; hydration of framework islands stays with the islands owner.

**BROW-008** (keyboard/screen reader, focus/selection, reduced motion, offline, layout shift) — Proven: caret + backward selection in unbound inputs, textarea selection with a newer bound draft during an in-flight request, focus to root on removal with temporary tabindex release, keyed moves keep focus, user focus never stolen, root and window scroll retained, live region updated in place (same node), `aria-busy`/status ARIA, reduced motion skips leave transitions, offline hint semantics, keyboard activation and key filters, axe scan in three browsers. Gaps: manual NVDA/VoiceOver checks, layout-shift measurement (CLS), shadow DOM/iframe/multi-range selection.

**BROW-010** (DOM ownership) — Matrix rows for `nv:ignore`, `nv:ignore.self`, `nv:replace` vs morph. Gaps unchanged: official framework islands, teleports, external widget teardown.

**BROW-013** (morph preservation) — Adds unbound select/checkbox/contenteditable preservation, scroll, keyed focus, caret/selection rows. Gaps unchanged: teleports, file models, checkbox groups, nested paths, out-of-order network beyond revision checks.

**BROW-014** (`$live` helpers) — `call/get/set/dispatch/on` implemented with automatic cleanup; `state` and `entangle` intentionally omitted with rationale (`packages/alpine/README.md`). Recommend Done if the "only where intentional and documented" clause is accepted. Gap: no real-Alpine browser test for `$live.on` (unit tests only).

**BROW-017** (poll visibility pause) — Chromium row: poll ticks, pauses while `visibilityState` is hidden for >2 intervals, resumes on visible.

**BROW-020** (progress, cancellation, pending transitions) — `.delay` pending states, targeted counts and suspension rows. Gaps unchanged: upload/stream progress UI acceptance, retry with jitter.

**BROW-022** (developer instrumentation) — Not changed.

**DIR-004 `nv:click`** — Complete modifier matrix: grammar oracle over all combinations plus Chromium rows for disabled/fieldset, keyboard buttons, `.prevent` with/without links, `.stop`, `.self`, `.once`, `.debounce`, `.throttle`, `.once.debounce`, `.ctrl`, `.alt.meta`, `.prevent.stop.self` ordering, `.document.once`; lab in three browsers. Recommend Done.

**DIR-005 `nv:submit`** — Native constraint validation blocks submission, nested submit buttons and implicit Enter share one binding, duplicate submits suppressed while pending, pending-disabled submitter, `.debounce`, denied confirmation still prevents native submission; lab (Chromium/Firefox/WebKit). Recommend Done; full forms package remains a separate row.

**DIR-006 `nv:model`** — Grammar over every mode/cast/timer combination and order; Chromium rows for defer, live, debounce, throttle (leading-only), blur, change/lazy, number (exponent, hex rejected, requests blocked), boolean select, checkbox/radio/multiple select, textarea, IME, action cancels timers, dirty/text interplay, `$sync` loading target; lab adds `.blur.number` and live debounce with server validation. Gaps unchanged: file/array setters, checkbox groups, nested paths.

**DIR-007 `nv:loading`** — Delay implemented (previously listed as unsupported). Rows: visibility/remove, class + class.remove + ARIA attr on one element with targets, quick work never shown (MutationObserver), slow work shown after delay, `.attr.delay`, concurrent per-action counts, `$sync`, server-disabled baseline, mixed-delay rejection, root `aria-busy`; lab in three browsers. Recommend Done. Documented limitation: a delayed indicator restarts its delay after each applied response while work stays queued.

**DIR-008 `nv:dirty`** — Field and any-field indicators cleared by server agreement or by restoring the server value; lab. Gap: restored-snapshot lifecycle across navigation remains with forms.

**DIR-009..014, DIR-018, DIR-023** (already Done) — Added combination rows (poll visibility, init + loading placeholder, navigate under Trusted Types, confirm combinations including `.once`, offline during suspension, transition under reduced motion, intersect once, current exact/prefix).

**DIR-015 `nv:show`** — Hidden/aria-hidden and focus fallback (Chromium + lab three browsers), with leave transition and reduced motion. Recommend Done.

**DIR-016 `nv:stream`**, **DIR-017 `nv:sort`** — Grammar rows only; behavior unchanged and gaps (HTML streaming, touch/grid/cross-list) unchanged.

**DIR-019 `nv:ignore`**, **DIR-020 `nv:replace`** — Matrix rows (subtree/wrapper preservation, replacement resets local state with remove/insert events). Gaps unchanged (framework islands, teleports).

**DIR-021 `nv:text`** — Escapes markup (no element created from `<b>`/`<img onerror>` state) in Chromium and under CSP. Recommend Done.

**DIR-022 `nv:cloak`** — Removed after successful initialization, including under strict CSP. Gap: visual FOUC measurement.

**DIR-024 `nv:ref`** — Resolves and disappears with its element across server re-render. Recommend Done.

**DIR-025 `nv:bind`** — Allowlist grammar table, `aria-expanded` booleans (Chromium + lab), `javascript:` rejected before writing. Recommend Done (style/property binding intentionally unsupported).

**DIR-026 modifiers** — `.window`/`.document` implemented with the safe-scoping rules above; `.confirm` equivalent is `nv:confirm` (combinations proven); precedence documented in `docs/reference/nv-events.md`; unknown-modifier errors and event object sanitization (no event data sent) covered. Recommend Done.

## Docs

`docs/reference/directive-matrix.md` (new), `docs/reference/nv-loading.md` (new), `docs/reference/nv-events.md` (new), `docs/guides/csp.md` (new), `docs/reference/directives.md`, `nv-confirm.md`, `nv-offline.md`, `packages/client/README.md`, `packages/alpine/README.md`, `examples/directive-lab/README.md`, `.changeset/client-directive-matrix.md`. `pnpm docs:build` passes.

## Remaining gaps (not claimed)

Manual screen-reader verification; CLS/layout-shift measurement; matrix rows run in Chromium only (Firefox/WebKit run the lab flows); code splitting; teleports and framework-island teardown; request bundling/retry; HTML streaming; touch sort. A server action that throws ends that server instance (`410` on the next request, `packages/live` behavior), so the client suspends; only the 4xx allowlist is recoverable.

## Merge notes

- New example `examples/directive-lab` (port 3360) → root `playwright.config.ts` webServer entry added; `pnpm-lock.yaml` gains its importer.
- `package.json`: `client-directive-grammar` added to `test:unit` and `test:security`; `client-directive-combinations` and `client-runtime-resilience` to `test:integration`; `client-csp` to `test:security`.
- `packages/client/src/index.ts` is large and shared; expect textual conflicts only if another branch edits `cancelSubtree`, the direct-listener callback, `resolveEvent` or `syncDirectListeners`. `realtime.ts` was not touched.
