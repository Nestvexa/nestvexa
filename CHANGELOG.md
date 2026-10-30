# Changelog

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
