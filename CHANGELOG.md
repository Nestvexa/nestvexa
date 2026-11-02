# Changelog

## Unreleased: optional i18n, UI, AI, flags and offline extensions

Added `@nestvexa/i18n` (allowlisted negotiation, catalogs, ICU plural/select
subset, Intl formatting, RTL, HBS helpers, key extractor), `@nestvexa/ui`
(unstyled accessible dialog, tabs, combobox, toast, sortable headers, pagination,
disclosure, progress and a CSP-safe keyboard module), `@nestvexa/ai`
(provider-neutral streaming chat with server-enforced tool approval),
`@nestvexa/flags` (fail-closed flags with guard, view and Live helpers) and
`@nestvexa/offline` (identity-scoped drafts, read-only snapshots, safe reconnect),
with the `examples/admin-i18n` English/Arabic admin. `HbsEngine.registerHelpers`
lets optional packages add trusted helpers before initialization.

## Unreleased: React, Vue and Svelte adapters with Vite and SSR

Added `@nestvexa/vite` (manifest tags with CSP nonces, immutable static serving,
in-process SSR bundles, official Inertia SSR server launcher, dev middleware) and
`@nestvexa/react`, `@nestvexa/vue` and `@nestvexa/svelte` over the official
Inertia 3.10 clients with hydration, error boundaries and SSR. Frameworks are peer
dependencies. Examples: `inertia-react`, `inertia-vue`, `inertia-svelte` and
`inertia-mixed` (all three frameworks in one host).

## Unreleased: universal server actions

Added `@nestvexa/actions`: explicitly registered, authorization-first server
actions served by real Nest controllers (guards, pipes, interceptors, filters),
with strict admission (origin, CSRF, JSON limits, rate limits), timeouts,
idempotency keys, schema validation, a typed error envelope and a generated typed
browser client (`@nestvexa/actions/codegen`). Example: `actions-basic`.

## Unreleased: alternative template engines

Added optional EJS, Pug and Nunjucks adapters that escape by default, render
`SafeHtml` (including Live mounts), confine templates to the configured root and
report template locations in development. `@nestvexa/views` exposes the shared
adapter kit. Example: `custom-engine`.

## Unreleased: forms and uploads

Added `@nestvexa/forms` (Zod/class-validator/custom adapters, hardened input,
Live validation, wizard, drafts, no-JS POST fallback with CSRF and 303 redirects)
and `@nestvexa/uploads` (streaming limits, magic-byte checks, single-use tokens,
resumable chunks, quotas, S3 SigV4 without an SDK, scanner hook, Range downloads,
`nv:upload` directives). Examples: `auth-forms` and `uploads`.

## Unreleased: islands

Added `@nestvexa/islands` and the `examples/hybrid-dashboard` page with React, Vue
and Svelte islands beside a Live component that owns a React island.

## Unreleased: observability

Live emits `nestvexa.live.mount/action/render` spans through an optional
`instrumentation` policy. `@nestvexa/observability` adds an OpenTelemetry bridge,
in-memory metrics, redacted logging and a development-only devtools panel.

## Unreleased: CLI, cache and CommonJS hosts

Added the `nestvexa` CLI (`@nestvexa/cli`) and `@nestvexa/cache`. All packages now
declare a `default` export condition so CommonJS Nest apps load them via
`require(esm)` on Node 22.12+.

## Unreleased: realtime invalidation, Inertia adapter

Added `@nestvexa/realtime` (SSE/poll/WebSocket, identity-bound tokens with key
rotation, bounded queues, revocation, memory and Redis-protocol brokers, owner-bound
jobs) and `@RealtimeChannels()` Live integration with a `/realtime` starter page.
Merged the verified Inertia v3 server adapter `@nestvexa/inertia` with an official
React client example.

## Unreleased: navigation, optimistic UI, downloads, flash, pagination and typed state

Added `nv:navigate` (same-origin document swaps with full-load fallback,
history/scroll/focus handling, hover prefetch and unsaved-edit confirmation) and
`nv:optimistic` (data-literal projections with rollback events). Actions can
create single-use identity-bound downloads (`downloadLive`) and session flash
messages (`flashLive`/`consumeLiveFlash`). Added the pure `paginate` helper and
`DateSynthesizer`/`BigIntSynthesizer` typed state. The starter gained a full
`/projects` CRUD board used as the Phase 4 browser gate.

## Unreleased: nested components, events, lazy loading and redirects

Parents mount keyed children through an explicit `children` allowlist and the
trusted `nvChild` helper. `@Prop`, `@Reactive` and `@Modelable` define
parent-owned values; unchanged children are retained as stubs, changed reactive
values refresh only that child (`data-nv-refresh`), removed children are revoked.
Actions dispatch browser-routed events to `@OnEvent` listener actions, which
validate payloads as ordinary input. Lazy components render a placeholder and
load through `$sync`. `redirectLive` accepts application-relative paths only.
The custom client gzip budget is revised from 35 KiB to 48 KiB (ADR 0020).

## Unreleased: renderless actions

Added opt-in `@Action({ renderless: true })`. With the exact `renderless-v1`
client capability the server returns post-dehydrate state, URL effects and the
next snapshot without render hooks, computed values or template work; the
browser refreshes bindings on the retained subtree without an HTML morph.
Unknown capabilities, normal actions, `_sync` and stream refreshes keep full
rendering. The complete security pipeline is unchanged.

## Unreleased: owned sorting, bounded action inputs and text streams

Added `nv:sort` with keyboard/native-pointer proposals, exact item-set validation
in a real Nest example, pending announcements and server-authoritative ordering.
Drag attributes are reconciled across Live morphs. Programmatic action inputs are
detached at enqueue and bounded before network dispatch.

Added explicit `nv:stream` text targets, trusted endpoint configuration and
ordinary Nest streaming routes with repeated host authorization, CSRF/identity/
revision checks, bounded output, backpressure and cancellation. Application
shutdown cancels active streams; uncooperative producers retain quota until they
settle. Fresh registered component instances share request-scoped dependencies
without sharing mutable sibling fields. Whole Phase 4 acceptance remains open.

## Unreleased: Phase 4 context, background directives and request cleanup

Added validated `@Url` and identity-namespaced `@Session` state, optional query
history effects, awaited render/error/disposal hooks, polling/intersection,
visible/idle initialization, offline/current indicators and CSS transitions.
The activity starter has protected real actions and an ordinary GET fallback.
Request cleanup precedes snapshot/session commit; uncertain actions are never
retried automatically. Independent admitted roots retain ownership inside parent
ignore slots. New hook names are reserved in this alpha.

The canonical client entry is now one minified ESM bundle. Private implementation
JavaScript is excluded from package files and the default asset catalog. Linked
source maps and documented declarations remain packaged; maps are not served by
the default asset route. The existing 35KiB custom-runtime gzip budget is retained.
Full Phase 4 and Phase 5 acceptance remain outstanding.

## Unreleased: async computed values and request-local memoization

Added explicit async computed methods, public `ComputedOptions`, state dependency
keys, stage invalidation, TTL, bounded async waits and detached JSON results.
Managed getters now cache by default; use `cache:false` to evaluate on every read.
Computed overrides must be decorated explicitly. Derived names cannot be actions
or writable state. Added real Nest/browser and packed-consumer coverage, without
a Live protocol change or new browser module.
Computed methods reject ineffective Nest route/parameter/policy decorators rather
than implying guard execution. Cross-realm rejected getter Promises are handled
before the unsupported synchronous read fails.

## Unreleased: bounded eager initialization

Added `nv:init` with one registered-action attempt per component registration,
microtask dispatch after the synchronous mounting turn, capacity limits and
ownership/disposal cancellation. Automatic retries are disabled. The startup
panel example covers permitted and denied actions, loading and Alpine retention.
Lazy/deferred scheduling remains unimplemented; the Live wire protocol is unchanged.

## Unreleased: confirmed browser actions

Added plain-text `nv:confirm`, native dialog defaults and a typed asynchronous
host callback with abort signals, bounded deadlines/capacity, duplicate suppression
and late-approval rejection after configuration, ownership or lifecycle changes.
Confirmation is presentation only; real Nest authorization/CSRF/session checks
remain required. The work-board example adds a confirmed seed-data removal action
and safely adds items after the list becomes empty. Wire protocol is unchanged.

## Unreleased: Phase 4 request and update lifecycle

Added awaited `boot`, `beforeUpdate` and `afterUpdate` hooks with typed,
recursively frozen detached update context, input/guard ordering and shutdown
checks between stages. Hook names are reserved from client state/action exposure;
older alpha members using these names must be renamed. No wire protocol change
or business side-effect rollback is implied. Remaining Phase 4 features stay open.

## Unreleased: Phase 3 timing diagnostics and reactive work board

Added opt-in frozen queue/request/morph timing samples with no state, identities,
URLs, action names or retained buffer; instrumentation sink failures cannot
change mutation semantics. Added a real HBS/decorator search/sort/form example,
browser security/accessibility/navigation checks, nested DOM ownership coverage
and visual round-trip fixtures. Phase acceptance depends on recorded verification.

## Unreleased: bounded multiple-select model arrays

Native multiple selects support unique flat string/number/boolean arrays, ordered dirty equality, shared alias projection, bounded option/state validation and native reset reconciliation. Added real Nest synchronization/action/validation/session scenarios. Public client/Alpine setters remain primitive-only; checkbox groups, file models and complete forms remain unmet. Browser JavaScript emits without source comments while a separate declaration pass preserves API documentation and external maps; the existing size budget is unchanged.

## Unreleased: retained local editor selection

Live updates preserve one native caret or forward/backward range in a retained owned editable host, including keyed ancestor moves, Unicode and plaintext-only editors. Selection restoration runs before focus and respects host callback changes. Added controlled ownership/replacement regressions and real Nest browser scenarios. This does not implement rich-text models or selection remapping across replacement/plugin boundaries; complete Phase 3 acceptance remains open.

## Unreleased: visibility and loading focus ownership

Visibility, dirty indicators, loading visibility and post-update restoration now share temporary focusability cleanup. Shared ancestor fallbacks retain their temporary tabindex until their remaining owners release it or focus leaves. Added focused browser/controller regressions and included the new client module in asset hosting. Complete Phase 3/accessibility acceptance remains open.

## Unreleased: focus after Live updates

Reconciliation now falls back to an available component root when a focused control becomes disabled, hidden or inert, preserves focus chosen by host hooks, and releases its temporary focusability on blur/release/disposal. Added real-server browser scenarios and controlled lifecycle regressions. Complete accessibility and Phase 3 acceptance remain open.

## Unreleased: integrated default Live setup

Added explicit umbrella Live registration with async host policy injection, one shared HBS engine, external browser boot and `nvScripts` layout helper. Added delegated Alpine startup with document ownership and persisted-page lifecycle handling, plus an umbrella-only starter and external consumer coverage. Existing manual Live renderer and browser setup remain supported. Full master-plan release gates remain open.

## 0.1.0-alpha.0 — unreleased

Added explicit `nestvexa/assets` hosting for allowlisted Live/Alpine modules with immutable content-addressed URLs, version-neutral Nest routes and conditional GET/HEAD. The umbrella declares its browser runtime dependencies, and the Live example replaces individual asset routes with the shared manifest. Browser startup and Live security policies remain host-owned.

Reconciled native form reset with owned primitive model drafts, previews, dirty state and pending model timers. Canceled resets preserve drafts; completed resets use new field versions to survive in-flight responses without automatically dispatching synchronization. Invalid defaults and cross-owner radio reset groups reject explicitly. Reset reconciliation now finishes after native button event dispatch even when no client API is called.

Added bounded request/body deadlines, streaming byte limits, strict response decoding and stable transport errors with numeric HTTP status. Uncertain outcomes now stop queued/nested transport while preserving drafts and enhanced form prevention until explicit reconciliation. Removal/disposal settles canceled client work promptly; cancellation does not acknowledge server success or rollback.

Added `nv:ignore.self` for attribute-owned wrappers with Live-owned children, effective markup preflight, frozen directive configuration, explicit conflict errors and cleanup on ownership transitions. Malformed whole-ignore declarations now reject setup; the bare-ignore parser result is unchanged.

Added native control default merging, keyed selection preservation, coherent textarea/reset behavior, and marker/ownership transition cleanup. Unbound control drafts stay local and are not added to Live state. Changed server defaults and explicit replacement remain authoritative. Fixed hidden dirty values after control schema changes and duplicate/obsolete event transport errors after cancellation.

Corrected native radio grouping for unresolved form references; detached incoming references now resolve against projected internal/external form owners before restoring local choices.

Added `nv:replace`/`.self`, removal/insertion lifecycle signals, targeted loading visibility/class/attribute effects, and reversible control baselines. DOM replacement resets owned local widget/input state; removed controls no longer retain hidden dirty edits or scheduled handlers.

Fixed a post-morph caret exception when a focused text input becomes a number, email or file input, preventing stale client revisions after a successful server response.

Added model synchronization through an explicitly authorized Nest `_sync` route, with class/global execution semantics and recoverable state validation. Added live/blur/change/lazy model timing, finite numeric and strict boolean casts, native single-select/radio inputs, composition handling and ownership-aware timer cleanup. Model synchronization does not invoke action methods or their method guards; hosts must explicitly authorize `$sync` and protect component access at class/global scope.

Added explicit keyboard actions, safe event modifiers and bounded debounce/throttle scheduling. Corrected competing-client ownership, disconnected element-root cleanup and native ancestor propagation. The verified foundation is preserved in local commit `2bb6274`; current reports distinguish subsequent implementation evidence.

Initial implementation of the strict TypeScript workspace, core configuration and registries, view engine contract, Handlebars adapter and default MVC distribution. Automated checks and examples are being established. No npm release has occurred; consult implementation evidence before relying on individual capabilities.
