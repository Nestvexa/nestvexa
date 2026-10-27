# Changelog

## 0.1.0-alpha.0 — unreleased

Added `nv:replace`/`.self`, removal/insertion lifecycle signals, targeted loading visibility/class/attribute effects, and reversible control baselines. DOM replacement resets owned local widget/input state; removed controls no longer retain hidden dirty edits or scheduled handlers.

Fixed a post-morph caret exception when a focused text input becomes a number, email or file input, preventing stale client revisions after a successful server response.

Added model synchronization through an explicitly authorized Nest `_sync` route, with class/global execution semantics and recoverable state validation. Added live/blur/change/lazy model timing, finite numeric and strict boolean casts, native single-select/radio inputs, composition handling and ownership-aware timer cleanup. Model synchronization does not invoke action methods or their method guards; hosts must explicitly authorize `$sync` and protect component access at class/global scope.

Added explicit keyboard actions, safe event modifiers and bounded debounce/throttle scheduling. Corrected competing-client ownership, disconnected element-root cleanup and native ancestor propagation. The verified foundation is preserved in local commit `2bb6274`; current reports distinguish subsequent implementation evidence.

Initial implementation of the strict TypeScript workspace, core configuration and registries, view engine contract, Handlebars adapter and default MVC distribution. Automated checks and examples are being established. No npm release has occurred; consult implementation evidence before relying on individual capabilities.
