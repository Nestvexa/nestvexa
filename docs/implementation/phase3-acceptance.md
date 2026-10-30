# Phase 3 acceptance review

Status: **accepted for tasks 3.1–3.7 and their exit gate on the executed Windows
environment**. `pnpm phase3:check` passed at **2026-10-30T09:40:24.072Z**, against
the full checkpoint at **2026-10-30T09:35:07.311Z**: **929 aggregate tests and 192
three-browser checks**, seven tarballs and four external full/minimal npm/pnpm
consumers. [The saved gate](phase3-acceptance-evidence-2026-10-30.json) records
source/report hashes, scope and evidence. Overall release remains blocked.

This review follows tasks 3.1–3.7 and the exit gate in the untouched master
specification. It does not replace the complete feature ledger or accept phases
0–2, 4–17. In particular, Linux execution and the complete release matrix remain
separate unresolved requirements; workflow configuration is not execution.

| Task | Implemented contract                                                                                                                                                  | Principal evidence                                                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1  | Explicit/idempotent client mount/dispose, one Alpine CSP startup owner, lifecycle cleanup; scoped `$live.call/get/set` bridge                                         | `tests/alpine.test.ts`, `tests/alpine-start.test.ts`, `tests/browser/default-setup.spec.ts`, `tests/umbrella-live.test.ts`                                                                                                                                                                                   |
| 3.2  | Keyed morph, native drafts/defaults/files, focus/directed selection/scroll, nested DOM ownership and removal cleanup                                                  | `tests/client-native-controls.test.ts`, `tests/client-focus.test.ts`, `tests/client-ownership-transitions.test.ts`, `tests/client-rendering-lifecycle.test.ts`, `tests/browser/native-controls.spec.ts`, `tests/browser/editor-selection.spec.ts`, `tests/browser/phase3-board.spec.ts`                      |
| 3.3  | click/submit/model, loading/targets, dirty/text/bind/cloak/ignore/replace/ref/show and the documented closed modifier grammar                                         | `tests/client-bindings-dom.test.ts`, `tests/client-events.test.ts`, `tests/client-models.test.ts`, `tests/client-loading.test.ts`, `tests/client-replace.test.ts`, `tests/browser/live.spec.ts`, `tests/browser/events.spec.ts`, `tests/browser/models.spec.ts`, `tests/browser/replacement-loading.spec.ts` |
| 3.4  | Data-only grammar, registered identifiers, rejected expressions/unsafe HTML/URLs/prototype keys; delegated owned events                                               | `tests/client-security.test.ts`, `tests/client-bindings.test.ts`, `tests/client-events.test.ts`, `tests/security.test.ts`, `tests/live-security.test.ts`                                                                                                                                                     |
| 3.5  | Bounded serial queues, duplicate submit suppression, debounce/leading throttle, abort/deadline, identity/revision checks, no automatic retries, DOM lifecycle signals | `tests/client-model-scheduler.test.ts`, `tests/client-lifecycle.test.ts`, `tests/client-transport-lifecycle.test.ts`, `tests/browser/request-lifecycle.spec.ts`, `tests/browser/events.spec.ts`                                                                                                              |
| 3.6  | Real Nest browser checks: mouse/keyboard/forms, ordinary Back/Forward, Alpine retention, parent/child DOM mutations and accessibility                                 | `tests/browser/default-setup.spec.ts`, `tests/browser/phase3-board.spec.ts`, `tests/browser/form-reset.spec.ts`, `tests/browser/multiple-select.spec.ts`, `tests/browser/visibility-focus.spec.ts`                                                                                                           |
| 3.7  | Opt-in redacted queue/request/morph timing, per-module bundle analysis, real restrictive CSP pages                                                                    | `tests/client-transport-lifecycle.test.ts`, `scripts/size.mjs`, `tests/browser/assets.spec.ts`, `tests/browser/phase3-board.spec.ts`, `docs/guides/client-diagnostics.md`                                                                                                                                    |

The exit example is `/board` in `examples/starter-live`: HBS and decorators build
a searchable/sortable table and validated add form. Its tests exercise escaped
hostile text, forged locked fields, invalid/oversized state, pending controls,
keyboard submission, stable keyed rows, local Alpine/input retention and empty
states. It uses real session-bound Nest endpoints, not intercepted fake actions.

The visual fixture captures the actual rendered board before and after a keyed
sort round trip, requires pixel-identical neutral presentation and attaches both
PNGs. It runs separately in Chromium, Firefox and WebKit and does not substitute
Windows font screenshots for Linux baselines. This is a visual invariant test,
not a claim of an independently reviewed design baseline.

`/board/ownership` mounts two independent registered components on the server.
The browser fixture explicitly moves the second root into an ignored host slot,
then mutates both through real authorized endpoints and proves their independent
revisions/drafts. This verifies Phase 3 DOM ownership. It does not implement Phase
4 nested server registration, reactive/modelable props or parent lifecycle APIs.

The Phase 3 public API remains the versioned alpha client contract in
[`@nestvexa/client`](../../packages/client/README.md),
[`@nestvexa/alpine`](../../packages/alpine/README.md) and
[the directive reference](../reference/directives.md). Supported native inputs,
invalid conversions, ownership boundaries, replacement behavior and recovery are
explicitly documented. No arbitrary expressions, checkbox array groups, nested
model paths, rich-text model, shadow-root editor or framework teleport ownership
is advertised. File selection preservation is not uploads. These are explicit
API boundaries, not implementations of later master features.

Later requirements stay tracked: the full `$live` event/entanglement API, server
nesting, lazy/defer, URL/session state, remaining directives, navigation/batching,
forms subsystem, uploads, framework islands, Linux/full matrix, manual screen
reader review, long-running memory/load and production devtools. No CLI or
official framework adapter is required to run the Phase 3 HBS example, and none is
represented as implemented here. No independent security audit is claimed.

Compatibility is additive: diagnostic collection is disabled by default, no
wire/schema version changes, no new dependency/module asset and no new package.
The existing client size cap remains unchanged. Acceptance required the complete
checkpoint to rebuild, run all aggregate/browser/security checks, pack all seven
packages and exercise the external npm/pnpm consumers; those checks passed as
recorded above.

The earlier generic Phase 3 outstanding notes also named later requirements;
those have not disappeared. BROW-010/013 retain full renderer/teleport ownership,
BROW-014 retains the remaining `$live` APIs, PHASE-046/047 retain server nesting
and lifecycle breadth, PHASE-048/049 retain later directives/batching/progressive
work, QA-071 and PHASE-013 retain Linux/full compatibility, and QA-077/PHASE-139
retain long-running performance work. They stay unfinished in the master ledger.
The Phase 3 rows PHASE-036 through PHASE-044 are accepted for their actual scope.
