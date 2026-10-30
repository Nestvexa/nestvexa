# Release checkpoint report — 2026-10-30

**A. Status: NOT YET READY — BLOCKERS.** This is an interim report, not Phase 17
acceptance. The latest Phase 4 initialization checkpoint passed **1,028 aggregate
tests and 219 browser checks**; Phase 4 is **InProgress**, with the rest of its
scope still incomplete. Phase 3 tasks 3.1–3.7 and their exit gate passed first on Windows:
**929 aggregate tests, 192 browser checks, seven tarballs/four external consumers**.
The [acceptance review](phase3-acceptance.md) and [saved gate](phase3-acceptance-evidence-2026-10-30.json)
record the exact scope and source/report hashes. The [925-unit ledger](feature-ledger.md)
accepts the nine Phase 3 rows and DIR-012 confirmation; phases 0–2/4–17 and the broader release/platform
requirements remain unfinished. Earlier checkpoint results below are historical.
Calendar dates follow Africa/Cairo and verification timestamps use UTC.

## B. What exists

Fresh isolated Windows Node **22.23.4** at **2026-10-30T09:40:27.942Z** and
**24.22.1** at **2026-10-30T09:42:32.661Z** each passed strict compilation and all
**929 aggregate tests**. They did not repeat the complete three-browser server or
external-consumer matrix. The [Phase 3 snapshot](phase3-checkpoint-evidence-2026-10-30.json)
preserves command timings, reports/tarball hashes, coverage scope, runtime results
and the acceptance gate. The cached-HBS-only benchmark at
**2026-10-30T09:39:59.778Z**, 1,000 iterations, measured p50 **0.1469ms**, p95
**0.2009ms**, p99 **0.2768ms** on Windows/i7-1165G7/host Node 24.13.0 before the
isolated runs. It is not a plain-Nest/application comparison or improvement claim.

Seven packages contain source, public types and READMEs: [core](../../packages/core/README.md), [views](../../packages/views/README.md), [engine-hbs](../../packages/engine-hbs/README.md), [nestvexa](../../packages/nestvexa/README.md), [live](../../packages/live/README.md), [client](../../packages/client/README.md) and [alpine](../../packages/alpine/README.md). The [HBS starter](../../examples/starter-hbs/README.md), [cookie-backed Live counter](../../examples/live-counter/README.md) and [integrated default starter](../../examples/starter-live/README.md) run on real Nest servers.

Live has generated Nest routes, bounded JSON/state tokens, host identity/CSRF/origin/authorization, revision checks and application-local registration ownership. Duplicate component types/names/routes reject startup consistently. Disjoint modules mount through their owning policy/store/renderer and reuse request context IDs without bypassing exports. Shutdown guards prevent late state creation. Manual renderer lifecycle is host-owned; integrated umbrella registration owns its one shared HBS renderer. Client event modifiers, keyboard filters, timer cleanup and isolated Alpine work to their [documented limits](../reference/directives.md).

The model slice adds deferred/live/blur/change/lazy modes, finite decimal and explicit boolean casts, bounded debounce/leading throttle, native single-select/radio values, IME handling and cleanup. Invalid local conversion blocks requests. The fixed `_sync` route requires explicit `$sync` authorization and component/global Nest policies; action-method guards do not apply and no action or action hooks run. Pure writable-state validators can return422 before component execution while preserving the snapshot for correction; transaction revision checks still reject conflicting writes. Full model/forms acceptance remains open.

The rendering slice adds per-action targeted loading, including queued requests and `$sync`, reversible visibility/class/allowlisted-attribute effects, server-baseline restoration and conflict checks. Explicit incoming child/self replacement resets native/file/Alpine local state, notifies outer-subtree removal/insertion, cancels removed client resources, moves removed focus to the retained root and clears dirty fields when every original control disappears. Ordinary morphing retains ownership boundaries; explicit ancestor replacement may remove them. The full nested-server API and official framework island lifecycle remain unimplemented.

The native-control slice preserves unbound local native values when incoming defaults are unchanged and applies changed server defaults. It updates native reset baselines, retains keyed option identity even with duplicate values, and clears hidden model drafts on incompatible control/field/cast changes. File selection preservation does not provide uploads; multiple selects are unbound-only. Raw consistency checks for seven registration markers invalidate external changes once and require explicit disposal/remounting. Island handoff releases ownership without fabricated DOM removal events. These client checks do not authenticate requests or replace server policies. Native radio names/forms must avoid shared groups across component owners; that isolation is not supported or proven. No dependency was added for this slice.

The wrapper-only ignore slice adds `nv:ignore.self` with effective incoming attribute projection before preview validation and native form-owner capture. The wrapper's attributes remain local while descendants keep ordinary Live behavior. Retained same-node `nv:*` configuration is fixed; conflicting writers and unsupported native/editable/renderer-root placements reject explicitly. Ownership transitions replace and clean up removed subtrees, while whole-ignore boundaries stay opaque until key/ancestor replacement. The [guide](../guides/ignore-self.md) documents limits. No dependency or server authorization guarantee was added.

Observed versions: Windows host Node 24.13.0, additional Node 22.23.4 and 24.22.1, pnpm 10.26.1, Nest 12.2.0, TypeScript 6.0.3, Handlebars 4.7.10, Vitest 5.0.5, Playwright 1.64.1, express-session 1.19.0, Alpine CSP 3.17.5 and axe Playwright 4.14.0. See [compatibility](../architecture/upstream-compatibility.md).

The transport slice adds `requestTimeoutMs`, a dispatch-to-body browser deadline, bounded geometric byte accumulation before strict UTF-8/JSON/protocol validation, and stable transport errors with `LiveHttpError.status`. Uncertain failures suspend component/nested transport while retaining draft/state access and enhanced-form prevention. Recovery is explicit authoritative reconciliation or reload before remount; no timeout, abort or resolved cancellation guarantees business rollback/success. No dependency or server execution deadline was added. See the [request lifecycle guide](../guides/request-lifecycle.md).

Native reset now reconciles actual defaults into owned primitive model drafts, previews and dirty state. It cancels affected model timers, uses new field versions across pending responses and preserves canceled resets. Invalid defaults, conflicting aliases and cross-owner radio reset groups reject before native reset; late unrepresentable values suspend transport. A single task fallback handles native button event timing and clears on disposal. Reset is local, does not automatically dispatch synchronization and does not authorize later server writes. The full forms package remains unimplemented.

The explicit asset host replaces the example's per-file controllers with an application-local immutable catalog and content-hash manifest. `nestvexa/assets` serves approved client, Alpine bridge and Alpine CSP code through ordinary version-neutral Nest handlers. It supports conditional GET/HEAD and excludes source maps, declarations and arbitrary filesystem paths. Successful responses use immutable caching; failed lookups retain a no-store baseline. Integrated umbrella registration now supplies async policy DI, shared HBS, `nvScripts` and an external boot module. Hosts retain sessions, authorization and CSP; existing Alpine startup uses manual mode. See [default setup](../guides/default-live-setup.md) for static route structure, URI version prefixes, BFCache retention and reload-only failed/disposed lifecycle.

Post-morph restoration now checks whether a retained focused control is available before restoring focus/caret. Controls disabled directly or through a fieldset, hidden, inert or no longer rendered use an available component-root fallback. A host-selected target from removal/focus hooks is preserved. Reconciliation-owned temporary tabindex/listeners release on blur, component release, subtree removal and disposal without removing a changed host value. Remaining gaps include unsupported editor selections, shadow/iframe/portal focus, manual screen-reader acceptance and cross-owner radio isolation.

Visibility/dirty bindings, loading visibility and post-morph restoration now share one client-owned focus controller. Temporary tabindex/listeners release on blur, component/owner cleanup and disposal while preserving different host values. Leases coordinate sibling/client owners sharing a fallback ancestor in the same installed module; releasing one owner retains another owner’s lease. Detached/reparented owners are pruned. Custom fixed browser file lists must add focus.js; the installed catalog now serves 14 client modules plus Alpine adapter/CSP (16 assets).

The retained editor slice preserves original native anchor/focus points through keyed moves, without exposing HTML as Live state. Replacement and other ownership/reset boundaries remain authoritative.

Native multiple-select models now use bounded unique flat string/number/boolean arrays, strict all-option catalogs, shared alias projection and ordered dirty equality. Empty selection is valid. Native reset records newer array versions, compares alias defaults structurally and cancels timers without an automatic request. Shape/cast changes discard incompatible older drafts before response projection. Public client/Alpine setters stay primitive-only and reject incompatible array-field writes atomically. Server item validation and authorization remain authoritative; see the [multiple-select guide](../guides/multiple-select.md).

## C. Evidence

### Current eager initialization checkpoint

The full Windows/host Node 24.13.0 runner at **2026-10-30T16:29:56.204Z** passed
frozen install, formatting/lint, strict build/typecheck, **1,028/1,028 aggregate
tests**, selected coverage, size, **219/219 Chromium/Firefox/WebKit checks**, seven
tarballs in four full/minimal external npm/pnpm consumers, docs, ledger, benchmark
and audit. No pending/skipped/unexpected/flaky results or browser runner errors
were reported. Pack timestamp: **2026-10-30T16:39:06.529Z**. Audit reported no known
vulnerabilities. The source-bound Phase 3 regression gate passed at
**2026-10-30T17:20:28.348Z**. `release:check` intentionally exited 1 because the
master remains incomplete. Command timings, source/report/ledger/tarball hashes
and isolated runtime outcomes are preserved in the
[initialization evidence](initialization-checkpoint-evidence-2026-10-30.json).

Isolated Windows Node **22.23.4** at **2026-10-30T17:20:32.199Z** and **24.22.1**
at **2026-10-30T17:23:04.678Z** each passed strict compilation and all **1,028
aggregate tests**. These runs do not repeat the full browser/consumer matrix under
both binaries. An additional packed initialization API probe passed strict
compilation and runtime parser checks in both full npm/pnpm consumers. Its first
invocations needed TypeScript 6's explicit `--ignoreConfig` and `--types node`
flags; those probe corrections changed no package source or normal consumer config.

The added corpus contains **10 parser cases, 28 controlled Chromium cases and
15 real Nest checks across three browsers**. It covers one-time attempts, repeated
mount, replacement, late declaration, independent inserted components, canceled
attempt retention, disposal/remount, capacity, malformed declarations, synchronous
startup ordering, denied actions, CSRF and session isolation, Alpine retention,
loading, no-JavaScript HTML/navigation and automated accessibility. A raw authorized
request may call `load` again: the directive is not durable business idempotency.

The first two scoped browser attempts passed 12/15 checks: the no-JavaScript test
first selected both legitimate `noscript` elements, then used a matcher that
excludes `noscript` text. Inspection confirmed the fallback was present in the
actual DOM. The final test selects its rendered paragraph; all 15 scoped checks
and the full 219-check run passed. A separate scoped launch found the manually
started diagnostic server still listening; its verified process was stopped
before rerunning. No test, browser project or accessibility rule was disabled.

Custom client output is **146,232 raw / 35,049 summed per-module gzip bytes across
14 modules**, below the unchanged 35,840-byte cap, excluding Alpine/adapter/maps.
No runtime dependency, asset module or Live wire field was added. This is a size
estimate, not observed HTTP compression or total startup cost. Selected coverage
remains **97.18% branches / 98.20% statements in three configuration/protocol/store
files**, excluding the client and most project code. The cached-HBS-only benchmark
at **2026-10-30T16:41:34.749Z**, 1,000 iterations on the recorded Windows/i7 host,
measured p50 **0.1847ms**, p95 **0.2816ms**, p99 **0.3532ms** before isolated runtime
runs. It is not an end-to-end/plain-Nest comparison or improvement claim.

The [reference](../reference/nv-init.md), [ADR 0013](../adr/0013-initialization-lifecycle.md)
and example document eager timing, consumed failures, 64 default attempts, explicit
remount behavior and ordinary server authorization. **DIR-010 remains InProgress**:
lazy/deferred timing and complete hydration integration are unmet. Ledger:
**97 InProgress, 818 Pending, 10 Done**. Manual assistive-technology acceptance,
Linux/full matrix, remaining Phase 4 features and release gates remain open.

### Earlier confirmation checkpoint

The full Windows/host Node 24.13.0 runner at **2026-10-30T14:49:10.016Z** passed
frozen install, format/lint, strict build/typecheck, **990/990 aggregate tests**,
selected coverage, size, **204/204 Chromium/Firefox/WebKit checks**, seven tarballs
in four full/minimal external npm/pnpm consumers, docs, ledger, benchmark and audit.
There were no pending/skipped/unexpected/flaky results or browser runner errors.
Pack timestamp: **2026-10-30T14:54:26.982Z**. Audit reported **no known
vulnerabilities**. `release:check` intentionally exited 1; the master is incomplete.
The Phase 3 regression gate passed at **2026-10-30T14:56:32.423Z**.

The **30 controlled Chromium confirmation cases** and **13 added parser cases**
cover async/dialog approval, literal text, keyboard/Escape/focus and axe, duplicate
submits, draft preservation, cancellation across owner/config/marker/dispose/remount,
uncertain transport, deadlines, capacity, malformed providers and `.once` native
navigation prevention. Nine new real Nest checks cover native prompts, an actual
authorized mutation, empty-list re-add, direct requests, CSRF and cross-session
denial. The server receives no confirmation claim and still enforces its policies.

An initial expanded custom-dialog fixture failed because axe requires an explicit
browser context rather than the browser's convenience page; it now uses a context
and all checks pass without disabling any accessibility rules. Strict checks caught
a deliberately invalid callback fixture and an un-narrowed DOM test element; the
fixtures now model the JavaScript contract violation explicitly and narrow the
actual button before invocation. Lint caught control-regex and timer style issues;
the source uses explicit character checks and a const timer, without rule disables.
The full checkpoint was rerun after corrections. No unrun old-source regression
or independent security certification is claimed.

Fresh isolated Windows Node **22.23.4** at **2026-10-30T14:56:36.766Z** and
**24.22.1** at **2026-10-30T14:58:26.249Z** each passed strict compilation and all
**990 aggregate tests**. They did not repeat the full three-browser server/consumer
matrix. The [saved confirmation checkpoint](confirmation-checkpoint-evidence-2026-10-30.json)
preserves source/report/ledger/tarball hashes, timings, versions and exact scope.
Ledger: **96 InProgress, 819 Pending, 10 Done**. Only DIR-012 joins the nine Phase 3
Done rows; PHASE-048 and Phase 4 remain InProgress.

Custom client: **143,539 raw / 34,613 summed per-module gzip bytes across 14 modules**,
below the unchanged 35,840-byte cap, excluding Alpine/adapter/maps. There is no new
dependency, asset module or Live wire field. This is not HTTP transfer compression
or total startup cost. Coverage remains **97.18% branches / 98.20% statements over
only three configuration/protocol/store files**, excluding most code, including
confirmation/lifecycle/client modules. The cached-HBS-only 1,000-iteration benchmark
at **2026-10-30T14:55:59.302Z**, before isolated runtime runs, recorded p50
**0.2044ms**, p95 **0.2755ms**, p99 **0.3134ms** on Windows/i7-1165G7/host Node
24.13.0; it is not an application comparison or performance-improvement claim.

The [individual reference](../reference/nv-confirm.md),
[ADR 0012](../adr/0012-confirmation-lifecycle.md) and sample document the 16-pending
limit, 30-second default approval deadline, true-only result, callback abort/cleanup,
native dialog blocking/suppression and explicit server trust boundary. The full
custom-dialog TypeScript snippet was also strict-compiled against the built public
client API. Manual screen-reader/native browser-chrome acceptance, Linux/full matrix,
remaining Phase 4 features and the overall release remain open.

### Historical first Phase 4 lifecycle checkpoint

The full Windows/host Node 24.13.0 checkpoint at **2026-10-30T09:51:23.195Z**
passed frozen install, formatting/lint, strict build/typecheck, **947/947 aggregate
tests**, selected coverage, unchanged browser size budget, **195/195 browser
checks** across Chromium/Firefox/WebKit, seven tarballs/four full-minimal external
npm/pnpm consumers, docs, ledger, benchmark and audit. No pending/skipped/flaky/
unexpected cases or browser errors were reported. Audit output: **no known
vulnerabilities found**. `release:check` correctly exited 1. The Phase 3 regression
gate also passed against this newer source at **2026-10-30T09:56:36.690Z**.

The first new focused server run passed 99/105; six tests incorrectly assumed
failed callbacks retained a reusable token. The existing store intentionally
revokes it because effects may already have committed. Tests/docs were corrected
to assert revocation, no action execution and rejection of further requests;
no store policy was weakened. The focused rerun passed all 105, and all 21
combined board/hook checks passed before the full 947/195 checkpoint. The new
hook flow uses real Nest endpoints in all three browsers.

The implemented [typed lifecycle](../../packages/live/src/lifecycle.ts),
[ordering/migration guide](../guides/live-update-hooks.md) and
[ADR 0011](../adr/0011-live-update-hooks.md) describe the executed boot/update
contract, frozen context, authorization/validation order, revocation and shutdown
boundaries. Full lifecycle/nesting, keys, computed invalidation, serializers,
URL/session/reactive/modelable/events and remaining Phase 4 directives/UX remain
unfinished. No Phase 4 row is marked Done.

Fresh isolated Windows Node **22.23.4** at **2026-10-30T09:56:39.934Z** and
**24.22.1** at **2026-10-30T09:58:39.184Z** each passed strict compilation and all
**947 aggregate tests**. These runs include real HTTP and controlled Chromium
fixtures, without repeating the complete three-browser server/consumer matrix.
The [saved lifecycle checkpoint](update-hooks-checkpoint-evidence-2026-10-30.json)
records the tested source hash, command timings, report/tarball hashes, runtime
results, coverage scope and Phase 3 regression gate. Ledger: **95 InProgress,
821 Pending, 9 Done**; the Done rows are Phase 3 only. Linux/full release matrix
and independent review remain open.

Client output remains **136,680 raw / 33,198 summed per-module gzip bytes across
14 modules**, excluding Alpine/adapter/maps, under 35,840. Selected coverage
remains **97.18% branches / 98.20% statements across only three config/protocol/store
files**, excluding lifecycle/runtime/client and most project code. The HBS-only
microbenchmark at **2026-10-30T09:56:06.797Z**, 1,000 iterations before isolated
runtime checks, measured p50 **0.1464ms**, p95 **0.1968ms**, p99 **0.2389ms** on
Windows/i7-1165G7/host Node 24.13.0. It establishes no application comparison or
performance improvement.

### Phase 3 acceptance

The complete checkpoint at **2026-10-30T09:35:07.311Z** passed frozen install,
format/lint, strict build/typecheck, **929/929 aggregate tests**, selected coverage,
size, **192/192 Chromium/Firefox/WebKit checks**, seven tarballs in four external
full/minimal npm/pnpm consumers, docs, ledger, HBS benchmark and dependency audit.
No skipped/pending/flaky/unexpected browser cases or runner errors were reported.
`release:check` intentionally exited 1. `pnpm phase3:check` exited 0 at
**2026-10-30T09:40:24.072Z**, verifying report timing, unchanged source, artifact
hashes and the six new board scenarios in every browser engine.

Custom client output: **136,680 raw / 33,198 summed per-module gzip bytes across
14 modules**, under 35,840, excluding Alpine/adapter/maps; not wire compression
or total startup. Timing diagnostics are disabled by default, bounded/redacted
and isolated from mutation behavior. No dependency or wire change was introduced.
Selected coverage still covers only three configuration/protocol/store files;
it does not establish whole-client/runtime coverage or independent security review.

Initial diagnostics verification found and fixed failure cleanup being reported
as cancellation; the final 44-case transport suite passed. The first expanded
board run passed 15/18: the negative HTTP fixture incorrectly resolved a relative
endpoint against the other example host. Absolute host resolution corrected it;
all 18 subsequently passed, followed by the full 192-case suite. The visual
fixture compares and attaches actual within-run initial/restored renders; it is
not a cross-OS design baseline. No assertions or accessibility rules were disabled.

### Historical multiple-select verification

The Windows/Node 24.13.0 full runner at **2026-10-29T08:16:22.385Z** passed **924/924 aggregate tests** and **174/174 browser checks** across Chromium/Firefox/WebKit, with no pending/skipped/flaky/unexpected cases or browser runner errors. Frozen install, format/lint, strict typecheck/all builds, selected coverage, size, seven tarballs in four external full/minimal npm/pnpm consumers, docs, ledger, benchmark and audit exited 0. Pack timestamp: **2026-10-29T08:21:07.770Z**. Release checking intentionally exited 1; no complete phase is accepted. The [saved snapshot](multiple-select-checkpoint-evidence-2026-10-29.json) preserves report hashes, package inventories and isolated runtime evidence.

The selected corpus passed **104 model tests, 59 reset/lifecycle tests (including 25 array cases), and 3 package contracts**. Twelve new real Nest checks cover synchronization, aliases, empty/reset, pending edits, server item validation and independent sessions. An initial browser attempt passed 9/12 because the forged-request fixture used a non-UUID request ID and correctly received 400 before item validation; corrected requests now reach and prove 422 item validation and 410 session ownership rejection. The initial native-control corpus retained one obsolete blanket multiple-select rejection assertion; it now tests valid catalogs and duplicate rejection. Two new compatibility regressions failed before the fix: an older string-array draft could reject a numeric-cast response, and a scalar draft could reject a new multiple-select control. Both now discard incompatible preview drafts and pass. An initial checkpoint stopped at formatting; another was canceled for that compatibility fix, and its child process tree was explicitly stopped before fresh verification. No fixture, assertion suite or accessibility rule was disabled.

Custom client: **134,987 raw / 32,818 summed per-module gzip bytes across 14 modules**, below the unchanged 35,840-byte budget, excluding Alpine adapter/upstream Alpine/maps. This is not total startup or observed HTTP compression. The initial array implementation measured 36,233 gzip bytes against 35,840; comment-free browser JavaScript emission brought it within budget. A second declaration-only TypeScript pass preserves declaration JSDoc; package contract tests verify documentation and external maps. No dependency or asset count changed. Selected coverage remains **97.18% branches / 98.20% statements over only three config/protocol/store files**, excluding models/reset/client and most project code. Cached-HBS-only benchmark at **2026-10-29T08:22:45.083Z**, 1,000 iterations: p50 0.2157ms, p95 0.3042ms, p99 0.3677ms on Windows/i7-1165G7/Node 24.13.0, before isolated runtime checks. No plain-Nest/application comparison or performance improvement is inferred.

Fresh isolated Windows Node **22.23.4** at **2026-10-29T08:23:01.277Z** and Node **24.22.1** at **2026-10-29T08:25:06.917Z** each passed strict compilation and all **924 aggregate tests**. These include real HTTP/Chromium DOM fixtures without repeating the complete three-browser server or four-consumer matrix under both binaries. Linux remains unverified; the October 29 Docker engine probe failed its named-pipe connection. No supported-version expansion is claimed.

Checkbox selection groups, file models/uploads, nested field paths, generic programmatic array setters, complete forms and the full directive/input/nested-renderer/accessibility/security/platform matrices remain unmet. New array real-server scenarios use the Express starter; no separate full array HTTP-adapter matrix or manual screen-reader acceptance is claimed. Phase 4 remains Pending, and the ledger remains 98 InProgress/827 Pending/0 Done.

### Historical retained-editor verification

The Windows/Node 24.13.0 full runner at **2026-10-29T07:40:17.867Z** passed **870/870 aggregate tests** and **162/162 browser checks** across Chromium/Firefox/WebKit, with no pending/skipped/flaky/unexpected cases or browser runner errors. Frozen install, format/lint, strict typecheck/all builds, selected coverage, size, seven tarballs in four external full/minimal npm/pnpm consumers, docs, ledger, benchmark and audit exited 0. Pack timestamp: **2026-10-29T07:44:08.894Z**. Release checking intentionally exited 1; no complete phase is accepted. The [saved editor snapshot](editor-selection-checkpoint-evidence-2026-10-29.json) preserves timings, hashes, package inventories and runtime results.

The 77-case controlled focus/rendering corpus and 24 real Nest editor checks passed, including actual Ctrl+Enter action dispatch. Three refined keyed-move Chromium regressions failed against the preceding client before the fix. The first scoped browser run passed 14/18: WebKit established its default caret after the focus event, invalidating the initial focus-observer approach. Restoring the range before explicit focus fixed all three engines. Two negative assertions initially assumed hiding/noneditable content destroys native selection; they now correctly verify no framework range write. An initial isolated Node22 run passed 869/870: the MVC Fastify fixture received an OS-assigned port that fetch rejected as a browser-reserved bad port. That fixture now uses node:http with the same real TCP endpoint and assertions; fresh host/isolated checks passed. No checks were skipped or disabled. The default starter accessibility scenario includes the new editor and passed automated axe checks; manual screen-reader acceptance remains open.

Custom client: **134,302 raw / 34,473 summed per-module gzip bytes across 14 modules**, below 35,840 excluding Alpine adapter/upstream Alpine/maps; not total startup or wire compression. Selected coverage remains **97.18% branches / 98.20% statements over only three config/protocol/store files**, excluding focus/client and most project code. Cached-HBS-only benchmark at **2026-10-29T07:45:24.686Z**, 1,000 iterations on Windows/i7-1165G7/Node 24.13.0: p50 0.1505ms, p95 0.1932ms, p99 0.2261ms, before isolated runtime checks. No plain-Nest/application comparison or performance improvement is inferred.

Fresh isolated Windows Node **22.23.4** at **2026-10-29T07:45:35.754Z** and Node **24.22.1** at **2026-10-29T07:46:57.817Z** each passed strict compilation and all **870 aggregate tests**. These include real HTTP/Chromium DOM fixtures without repeating the complete three-browser server or four-consumer matrix under both binaries. The Docker Linux engine remained unavailable on October 29 (named-pipe connection failed); Linux and full release compatibility remain unverified. No dependency version or browser asset count changed.

Unsupported selections include cross-editor/renderer ranges, replaced nodes, ignored plugins, editable Live roots, independently focused inherited descendants, multiple ranges, shadow DOM and iframes. Rich-text models, IME/undo-stack guarantees, full lifecycle/accessibility/security/platform matrices and independent security review remain unmet. Phase 4 remains Pending; no mandatory requirement was marked Done.

### Historical visibility/loading focus evidence

The Windows/Node 24.13.0 full runner at **2026-10-28T18:52:07.899Z** passed **841/841 aggregate tests** and **138/138 browser checks** across Chromium/Firefox/WebKit with no pending/skipped/flaky/unexpected cases or browser runner errors. Frozen install, format/lint, strict typecheck/all builds, selected coverage, size, seven tarballs in four external full/minimal npm/pnpm consumers, docs, ledger, benchmark and audit exited 0. Pack timestamp: **2026-10-28T18:54:55.530Z**. Release checking intentionally exited 1; no phase is accepted. The [visibility evidence snapshot](visibility-focus-checkpoint-evidence-2026-10-28.json) preserves timings, report/ledger hashes, package inventories and runtime evidence.

The new controller corpus passed 23/23. Four additional binding/loading cleanup cases and the combined 185-case integration corpus passed. Twelve focused real Nest browser checks passed across three engines. Those first selected integration checks already consumed newly built source, so no old-source red claim is made. The first full browser run passed 135/138: three asset checks retained an old expected file list without focus.js. The explicit expected list was corrected to include the new module before the final complete rerun; no checks were removed. Existing focused rendering, model, asset and default-startup behavior remains included in the full aggregate. Review found no critical ownership defect in the scoped controller, without constituting independent security/accessibility approval.

Custom client: 130,024 raw/33,565 summed per-module gzip bytes over 14 modules, below 35,840 excluding Alpine adapter/upstream Alpine/maps; not wire compression or total startup size. Selected coverage remains 97.18% branches/98.20% statements over only three config/protocol/store files, excluding focus/client and most project code. Cached-HBS-only benchmark at **2026-10-28T18:56:20.336Z**: 1,000 iterations, p50 0.1417ms / p95 0.1987ms / p99 0.2364ms on Windows/i7-1165G7/Node 24.13.0 before isolated checks. No plain-Nest/application comparison is inferred.

Fresh isolated Windows Node **22.23.4** at **2026-10-28T18:56:41.212Z** and **24.22.1** at **2026-10-28T18:57:42.521Z** each passed strict compilation and all **841 aggregate tests**. These include real HTTP/Chromium DOM fixtures without repeating the complete three-browser server or four-consumer matrix under both binaries. Linux/full release compatibility remain unverified.

Contenteditable selection, cross-owner native radio isolation, shadow/iframe/portal focus, independently duplicated client module coordination, manual screen-reader acceptance and full lifecycle/platform matrices remain open. Internal direct binding-helper callers must supply an explicit controller for owner disposal; its implicit default provides blur cleanup. Normal createLiveClient owns and disposes the shared controller.

### Historical post-morph focus evidence

The full Windows/Node 24.13.0 checkpoint at **2026-10-28T04:50:41.595Z** passed **814/814 aggregate tests** and **126/126 browser checks** across Chromium/Firefox/WebKit, with no pending/skipped/flaky/unexpected results or browser runner errors. Frozen install, format/lint, strict typecheck/all builds, selected coverage, size, seven tarballs in four external full/minimal npm/pnpm consumers, docs, ledger, benchmark and audit exited 0. Pack timestamp: **2026-10-28T04:54:02.190Z**. Release checking intentionally exited 1; no phase is accepted. The [saved focus evidence](focus-restoration-checkpoint-evidence-2026-10-28.json) records exact report hashes, command timings, tarballs and isolated runtime checks.

The first selected old-source run had four failures, four passes and 12 unselected cases; refined wrapper fixtures retain their controls. A further reentrant focus-handler regression failed in a 24/25 run and passed after preserving that handler target. The final 25-case controlled corpus includes 13 new cases. Nine focused real Nest checks cover disabled/hidden fallback and user focus changes while a response is held. No assertions or suites were disabled.

Docs generated 42 linked snapshots. Custom client: **127,228 raw / 32,810 summed per-module gzip bytes across 13 modules**, below 35,840 excluding Alpine adapter/upstream Alpine/maps; not total startup or wire compression. Coverage remains **97.18% branches / 98.20% statements over only three configuration/protocol/store files**, excluding focus/runtime/client and most project code. Cached-HBS-only benchmark at **2026-10-28T04:55:38.031Z**, 1,000 iterations on Windows/i7-1165G7/Node 24.13.0: p50 0.1668ms, p95 0.2181ms, p99 0.2489ms, before isolated runtime checks. No plain-Nest/application comparison or performance improvement is inferred.

Fresh isolated Windows Node **22.23.4** at **2026-10-28T04:56:05.131Z** and **24.22.1** at **2026-10-28T04:57:51.015Z** each passed strict compilation and all **814 aggregate tests**. They include HTTP/Chromium DOM fixtures without repeating the complete three-browser server or four-consumer matrix under both binaries. Linux remains unverified.

### Historical default-setup evidence

The [default-setup evidence snapshot](default-setup-checkpoint-evidence-2026-10-28.json) preserves that checkpoint's command timings, report hashes, seven tarball inventories and both isolated runtime checks. Historical snapshots below retain their original scope.

The default-setup runner began at **2026-10-28T02:59:04.282Z** on Windows/Node 24.13.0. Frozen install, format/lint, strict typecheck including all package/example builds, **801 aggregate tests**, selected coverage, size, **117 browser checks**, seven tarballs in four external full/minimal npm/pnpm consumers, docs, ledger, benchmark and high-severity dependency audit passed. `release:check` intentionally exited 1 with `releaseReady:false`. No pending/skipped/flaky/unexpected test results or browser runner errors were reported.

New scoped coverage includes 40 async Live cases, 35 umbrella cases on real Express/Fastify servers, 21 Chromium cases using actual Alpine CSP and the browser client, and four default-starter scenarios across three browsers. Controlled transport/persisted lifecycle fixtures do not establish universal transport or BFCache behavior. Minimal consumers directly install only umbrella/host peers and now verify shared HBS layouts, Live mount/action, CSRF/replay rejection, default boot imports, native REST and all 15 approved browser assets.

Final review added two boot/asset route-overlap regressions. They failed before the startup guard, with 33 other cases unselected, then the expanded 35-case umbrella suite passed. The final full checkpoint includes them. An intervening format run stopped on newly supplied owner brand-kit references; those originals remain unchanged and outside framework formatting checks. No source or test suite was excluded.

The docs build generated 41 snapshots. Client-only size: 125,282 raw / 32,275 summed gzip bytes over 13 emitted modules, below 35,840, excluding the Alpine adapter/upstream Alpine/maps. This is not total startup or wire compression. Coverage remains 97.18% branches / 98.20% statements over only three config/protocol/store files, excluding new setup code and most project code. Audit reported no known vulnerabilities, without independent security approval. Cached-HBS-only benchmark at **2026-10-28T03:03:15.660Z**: 1,000 iterations, p50 0.1832ms / p95 0.2352ms / p99 0.2696ms on Windows/i7-1165G7/Node 24.13.0 before isolated runtime checks; no application/plain-Nest comparison or improvement claim.

Fresh isolated Windows Node **22.23.4** at **2026-10-28T03:03:44.099Z** and **24.22.1** at **2026-10-28T03:04:38.381Z** each passed strict compilation and all **801 aggregate tests** with no failures/pending cases. These include real HTTP/Chromium DOM fixtures, without repeating the complete three-browser server or four-consumer matrix under both binaries. Linux and full release compatibility remain unverified.

### Historical asset-hosting evidence

The complete asset-hosting runner started at **2026-10-27T19:05:15.493Z** on Windows/Node 24.13.0 and passed **703/703 aggregate tests**, including **71 asset cases**, with 0 pending, plus **105/105 browser checks** from 35 scenarios across Chromium/Firefox/WebKit. No skipped/flaky/unexpected results or browser runner errors were reported. Frozen install, formatting, lint, strict typecheck/build, selected coverage, size, pack, docs, ledger, benchmark and audit exited 0. `release:check` correctly exited 1 with `releaseReady:false`. The [asset snapshot](asset-hosting-checkpoint-evidence-2026-10-27.json) preserves report timings, tarball inventories and hashes.

| Asset-hosting command/report  | Observed result and scope                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:e2e` | 703 aggregate and 105 three-browser passes; no pending/skipped/flaky/unexpected results                                             |
| `pnpm test:pack`              | Seven tarballs; four full/minimal npm/pnpm external strict-TypeScript and real Nest consumers; **2026-10-27T19:09:09.215Z**         |
| Minimal consumers             | Direct dependencies contain only `nestvexa` and host Nest peers; all 15 approved modules served without workspace resolution        |
| `pnpm size:check`             | **125,282 raw / 32,275 summed gzip bytes**, 13 custom Live modules; below 35,840 excluding Alpine/maps; not wire compression        |
| Coverage                      | **97.18% branches / 98.20% statements** over only three config/protocol/store files; not asset/runtime/client/project-wide coverage |
| Docs and audit                | 40 linked snapshots; no known audit vulnerabilities, without independent security approval                                          |
| Cached HBS microbenchmark     | **2026-10-27T19:11:01.892Z**, 1,000 iterations: p50 **0.1735ms**, p95 **0.2456ms**, p99 **0.2922ms**                                |
| Release gate                  | Exit 1; mandatory master features and full release matrices remain blocking                                                         |

The benchmark ran before isolated runtime checks on Windows/i7-1165G7/Node 24.13.0. It is a cached HBS adapter measurement with no plain-Nest/application baseline or evidence of improvement across checkpoints.

Internal review reproduced a conditional parser defect with **one selected failing test**: punctuation inside a valid quoted opaque ETag could become a wildcard. The initial expanded corpus passed **65/68**: two guard-header assertions misused an undefined value, while real Express HTTP behavior also reinterpreted a malformed list as 304 after the module parser rejected it. Corrected assertions, strict whole-list parsing and Nest's public `StreamableFile` response now pass both adapters without changing the malformed-header expectations. Two further pure cases reject trailing newlines. The final corpus is 71/71. Initial reports remain under `artifacts/reports/assets-etag-before.json` and `assets-initial.json`. A checkpoint attempt stopped at a contract-test syntax typo during formatting; it was corrected before the full pass. No suite or security assertion was disabled. Earlier focused package checks overlapped source/notice changes and are not substituted for the final complete runner.

Fresh isolated Windows Node **22.23.4** at **2026-10-27T19:11:19.922Z** and **24.22.1** at **2026-10-27T19:12:50.709Z** each passed strict compilation and all **703 aggregate tests**, with 0 failures or pending cases. Both are captured in the asset summary. They include HTTP/Chromium DOM fixtures but do not repeat the full three-browser server or four-consumer package matrix under both binaries. Linux and complete release compatibility remain unverified.

Historical reset and transport evidence follows with its original scope.

The native-reset host checkpoint started at **2026-10-27T17:54:42.885Z** and passed **631/631 aggregate tests with 0 pending** and **102/102 browser checks** (34 scenarios across Chromium/Firefox/WebKit), with 0 skipped/flaky/unexpected results or runner errors. The [reset summary](form-reset-checkpoint-evidence-2026-10-27.json) preserves timings, report hashes and package inventories. Frozen install, formatting, lint, strict typecheck/build, selected coverage, size, pack consumers, docs, ledger, benchmark and audit exited 0. Release checking intentionally exited 1: `releaseReady:false`.

The **34 controlled Chromium reset cases** include native button timing, cancellation, actual form owners, disabled/external controls, ignored boundaries, casts, invalid defaults, late invalid defaults, conflicting aliases, composition, stale plans, disposal and in-flight field versions. The native-button regression failed before the task fallback (1 selected failure, 31 unselected cases), exposing a stale preview/dirty state that an earlier getter-first assertion masked. No test was disabled. The first 21-check Nest attempt used a stale compiled example without the new asset route; after a full rebuild the focused reset/model run passed 21/21. These are separate fixture and source defects, not a claim that all failures proved a product vulnerability.

| Native reset command/report   | Observed result and scope                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:e2e` | 631 aggregate and 102 three-browser passes; no pending/skipped/flaky/unexpected results                                                |
| `pnpm test:pack`              | Seven tarballs in two external npm/pnpm strict-TypeScript and real Nest consumers; **2026-10-27T17:58:29.104Z**                        |
| `pnpm size:check`             | **125,282 raw / 32,275 summed gzip bytes, 13 modules**; cap 35,840 excluding Alpine/maps; not wire compression                         |
| Coverage                      | **97.18% branches / 98.20% statements**, only three configuration/protocol/store files; runtime/client/project-wide gates remain unmet |
| Docs and audit                | 39 linked snapshots; no known audit vulnerabilities, without independent security approval                                             |
| Cached HBS microbenchmark     | **2026-10-27T17:59:34.785Z**; 1,000 iterations, p50 **0.1910ms**, p95 **0.2681ms**, p99 **0.3141ms**                                   |
| Release gate                  | Exit 1, intentionally blocking full master delivery                                                                                    |

Fresh isolated Windows Node **22.23.4** passed strict compilation and all **631 tests** at **2026-10-27T17:59:50.057Z**; **24.22.1** passed the same compilation/631-test aggregate at **2026-10-27T18:02:06.065Z**. Both report 0 failures or pending cases and are captured in the reset summary. They include HTTP/Chromium DOM fixtures but do not repeat the full three-browser server or packed-consumer matrix under both binaries. Linux and complete release compatibility remain unverified.

The benchmark ran before isolated runtime checks on Windows/i7-1165G7/Node 24.13.0. It has no plain-Nest/application comparison and does not establish an improvement over earlier checkpoints. Historical transport and other evidence follows with its original scope.

The historical transport slice passed **39 controlled-transport Chromium cases** and **21 actual Nest browser checks**: 9 new checks from 3 scenarios across the three browser engines plus 12 existing model checks. An initial 27/34 transport-fixture result occurred during concurrent source/fixture changes and is not valid red-before proof for a single defect. An existing regression run passed 81/82; the remaining assertion expected a native/private exception message and now checks the stable redacted `NETWORK` contract. The first 9 new Nest checks used invalid non-UUID request IDs and assumed 200 from ordinary Nest POST routes; UUIDs and the actual 2xx success contract corrected those fixture premises. The subsequent 21/21 focused run passed without skipping checks.

Further internal review confirmed a nested-request continuation race: a child transport could complete just before a parent `NETWORK` failure suspended the child, yet the child's pending runtime continuation could still apply the response. The selected deterministic regression failed before correction, with 38 other cases unselected; this is not a full-suite red claim. Post-await and pre-commit failure checks now reject application after suspension, and the corrected unfiltered corpus passed 39/39 with 0 pending (`artifacts/reports/client-transport-final.json`). An earlier 596/93 combined runner preceded this fix and overlapped source changes near packing; its artifacts cannot validate final source.

The corrected complete host runner started at **2026-10-27T13:12:08.251Z** and passed **597/597 aggregate tests with 0 pending** plus **93/93 browser checks**, from 31 scenarios across Chromium/Firefox/WebKit with 0 skipped/flaky/unexpected results. All implemented-checkpoint commands exited 0 except the intentionally blocking `release:check`, which exited 1 with `releaseReady:false`. Browser report start is **2026-10-27T13:13:14.418Z**. The [transport evidence summary](transport-checkpoint-evidence-2026-10-27.json) preserves that host, package and isolated runtime results. Node 24.22.1 passed strict compilation and all 597 tests at **2026-10-27T13:16:26.189Z**, with no failures or pending cases. These isolated runs do not repeat the full three-browser server or consumer matrix under both binaries.

| Historical transport command/report                      | Observed result and scope                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, strict typecheck/build | Exited 0                                                                                                                                                      |
| `pnpm test` / `pnpm test:e2e`                            | 597/597 aggregate and 93/93 browser checks passed; no pending/skipped/flaky/unexpected results                                                                |
| `pnpm test:coverage`                                     | Selected configuration/protocol/store measurement passed; not project-wide/runtime/client coverage                                                            |
| `pnpm test:pack`                                         | Seven tarballs passed two external npm/pnpm strict-TypeScript and real Nest consumers; **2026-10-27T13:14:37.453Z**                                           |
| `pnpm size:check`                                        | **116,453 raw bytes, 29,962 summed per-module gzip bytes across 12 modules**, below 35,840-byte cap excluding Alpine/maps; not measured wire compression      |
| Docs, ledger and audit                                   | Exited 0; 38 linked docs snapshots and no known audit vulnerabilities, without independent security approval                                                  |
| HBS microbenchmark                                       | **2026-10-27T13:15:35.944Z**; 1,000 cached adapter iterations, p50 **2.7575ms**, p95 **35.6142ms**, p99 **63.5292ms**; contended with isolated Node 22 checks |
| Fresh isolated Node 22                                   | Strict compilation and 597 tests passed, 0 failed/pending; **2026-10-27T13:14:49.174Z**, Windows                                                              |
| Fresh isolated Node 24                                   | Strict compilation and 597 tests passed, 0 failed/pending; **2026-10-27T13:16:26.189Z**, Windows                                                              |
| `pnpm release:check`                                     | Correctly exited 1; incomplete master, matrices and review remain blocking                                                                                    |

The benchmark ran on Windows/i7-1165G7/Node 24.13.0 and overlapped isolated Node 22 compilation/tests. These actual values are retained as contended measurements; they are not a controlled comparison with plain Nest or evidence of a product regression. Earlier faster measurements are not substituted. Historical results below retain their original scope.

The historical self-ignore slice includes **41 passing controlled-transport Chromium fixture cases**, **5 new parser cases**, **one matcher regression covering 24 permutations**, and **9 new actual Nest browser checks** across Chromium/Firefox/WebKit. An editable-false wrapper under editable-true content initially produced **40/41** fixture passes; its correction is included in the subsequent complete host pass. Early strict compilation caught an unchecked array access and readonly `className` fixture assignments; both were corrected without suppression.

The first aggregate run passed **558 tests**, but its browser run passed only **72/84**. New example labels overlapped existing substring locators for “Display name” and “Slow increase”. Distinct “Widget author” and “Delayed wrapper update” labels, exact control locators and a named global status correct those fixtures. No tests or accessibility rules were removed. The corrected complete host runner started at **2026-10-27T12:39:50.278Z** and passed **558/558 aggregate tests, 0 pending**, plus **84/84 browser checks** (28 scenarios across three engines), with 0 skipped/flaky/unexpected results. All implemented-checkpoint commands exited 0 except the intentionally blocking `release:check`, which exited 1 with `releaseReady:false`.

| Historical self-ignore command/report                    | Observed result and scope                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, strict typecheck/build | Exited 0                                                                                                                                                 |
| `pnpm test` / `pnpm test:e2e`                            | 558/558 aggregate and 84/84 Chromium/Firefox/WebKit checks passed; no pending/skipped/flaky/unexpected results                                           |
| `pnpm test:coverage`                                     | Selected configuration/protocol/store measurement passed; not project-wide/runtime/client coverage                                                       |
| `pnpm test:pack`                                         | Seven tarballs passed two external npm/pnpm strict-TypeScript and real Nest consumers; **2026-10-27T12:42:56.028Z**                                      |
| `pnpm size:check`                                        | **108,526 raw bytes, 27,720 summed per-module gzip bytes across 11 modules**, below 35,840-byte cap excluding Alpine/maps; not measured wire compression |
| Docs, ledger and audit                                   | Exited 0; 37 linked docs snapshots and no known audit vulnerabilities, without independent security approval                                             |
| HBS microbenchmark                                       | **2026-10-27T12:43:58.116Z**; 1,000 cached adapter iterations, p50 **0.2447ms**, p95 **0.4285ms**, p99 **0.6467ms**; no plain-Nest/application baseline  |
| Fresh isolated Node 22                                   | Strict compilation and 558 tests passed, 0 failed/pending; **2026-10-27T12:44:23.866Z**, Windows                                                         |
| Fresh isolated Node 24                                   | Strict compilation and 558 tests passed, 0 failed/pending; **2026-10-27T12:45:35.967Z**, Windows                                                         |
| `pnpm release:check`                                     | Correctly exited 1; incomplete master, matrices and review remain blocking                                                                               |

The [self-ignore evidence summary](ignore-self-checkpoint-evidence-2026-10-27.json) preserves host558/84 results, both fresh isolated runtime passes, package hashes/inventories and selected measurements. Isolated runtime runs include HTTP/Chromium DOM cases but did not repeat the complete three-browser server or packed-consumer matrix under both binaries. These passes do not complete the master release or establish the full platform/renderer matrix.

The [native evidence summary](native-checkpoint-evidence-2026-10-27.json) preserves the historical complete host checkpoint started at **2026-10-27T04:31:22.595Z**. All implemented-checkpoint commands exited 0 except the intentionally blocking `release:check`, which exited 1 with `releaseReady:false`. This is scoped checkpoint success, not full master acceptance or validation of later self-ignore source. Windows Node 22.23.4 and 24.22.1 each subsequently passed strict compilation and all 511 aggregate tests; their report timestamps are **2026-10-27T04:33:52.095Z** and **2026-10-27T04:34:41.175Z**, respectively.

| Historical native/ownership command/report               | Observed result and scope                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, strict typecheck/build | All exited 0                                                                                                                                                     |
| `pnpm test`                                              | **511/511 passed, 0 pending**, including 39 native-control and 25 ownership-transition Chromium regressions                                                      |
| `pnpm test:e2e`                                          | **75/75 passed**, 25 scenarios across Chromium/Firefox/WebKit; 0 unexpected/skipped/flaky, including 15 new actual Nest checks                                   |
| `pnpm test:coverage`                                     | Selected configuration/protocol/store measurement passed; does not establish project-wide/runtime/client coverage                                                |
| `pnpm test:pack`                                         | Seven tarballs; npm and pnpm external consumers passed strict types and runtime checks; timestamp **2026-10-27T04:33:25.440Z**                                   |
| `pnpm size:check`                                        | **103,577 raw bytes, 26,541 summed per-module gzip bytes across 11 modules**, below 35,840-byte cap excluding Alpine/maps; not measured wire compression         |
| Docs, ledger and audit                                   | All exited 0; audit reported no known vulnerabilities, not independent security approval                                                                         |
| HBS microbenchmark                                       | **2026-10-27T04:34:41.826Z**, 1,000 cached adapter iterations; p50 **0.2612ms**, p95 **0.4024ms**, p99 **0.7217ms**; no plain-Nest/application baseline          |
| Fresh isolated Node 22/24                                | Each passed strict compilation and **511 tests, 0 failed/pending** on Windows; full three-browser server/consumer matrices were not repeated under both binaries |
| `pnpm release:check`                                     | Correctly exited 1; full master requirements, matrices and review remain unmet                                                                                   |

That native aggregate includes the focused 39 native-control and 25 ownership-transition Chromium regressions. Five actual Nest scenarios ran in all three browsers (15 checks); controlled-transport client regressions do not substitute for server protocol conformance. Historical reports below retain their original scope.

The native-control corpus initially failed 13 of 24 cases before the source corrections. The source fixes address native default/choice reconciliation, hidden drafts retained across input type/cast changes, duplicate event error dispatch and an abort error overriding registration invalidation. Initial new browser checks passed 6/12: an option fixture used an input-only value matcher, and the aborted request exposed the error-ordering defect. Attribute assertions and queue-only error reporting corrected those cases. A later assertion-green run still reported late interception callbacks and canceled-route fulfillment errors. Fixtures now await completion, decline canceled fulfillment and inspect actual failures rather than ignore errors. The final focused 12/12 run had no errors. These results are scoped internal verification, not full matrix acceptance or independent security review.

The [rendering evidence summary](rendering-checkpoint-evidence-2026-10-27.json) preserves the complete host checkpoint started at **2026-10-27T03:24:05.203Z**. All implemented-checkpoint commands exited 0 except `release:check`, which correctly exited 1 for unfinished master scope, matrix and review gates. Isolated Windows Node **22.23.4 and 24.22.1 each passed strict compilation and all 447 aggregate tests**. The complete three-browser server and packed-consumer suites ran under host Node 24.13.0.

| Historical rendering command/report                      | Observed result and scope                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, strict typecheck/build | All exited 0                                                                                                                                                |
| `pnpm test`                                              | **447/447 passed**, including 38 loading, 18 replacement and 12 rendering-lifecycle cases                                                                   |
| `pnpm test:e2e`                                          | **60 expected, 0 unexpected/skipped/flaky**, Chromium/Firefox/WebKit with 2 workers; 12 new rendering/input-type checks                                     |
| `pnpm test:coverage`                                     | **97.18% branches, 98.20% statements**, only three config/protocol/store files; excludes most runtime/action/client code                                    |
| `pnpm test:pack`                                         | Seven archives inspected; npm and pnpm consumers passed strict types, real MVC/Live policies and Node-safe imports; timestamp **2026-10-27T03:26:09.467Z**  |
| `pnpm size:check`                                        | **87,321 raw bytes, 22,896 summed per-module gzip bytes across 10 modules**, below 35KiB excluding Alpine/maps; not measured HTTP transfer                  |
| Docs, ledger and audit                                   | All exited 0; audit reported no known vulnerabilities, without implying independent security approval                                                       |
| HBS microbenchmark                                       | 1,000 cached adapter renders; p50 0.1932ms, p95 0.2609ms, p99 0.3064ms on the recorded Windows/Node/CPU; no plain-Nest or application comparison            |
| Isolated runtimes                                        | Windows Node 22.23.4 and 24.22.1 each passed strict compilation and 447 tests; full server/browser/consumer matrices were not repeated under those binaries |
| `pnpm release:check`                                     | Correctly exited 1; full master requirements, matrices and review remain unmet                                                                              |

The following model and registration tables preserve earlier verified checkpoints and their distinct artifact/runtime scope.

The [model checkpoint summary](model-checkpoint-evidence-2026-10-26.json) preserves the successful combined runner at **2026-10-26T20:22:16.515Z** on Windows/Node 24.13.0. All implemented-checkpoint commands exited 0; `release:check` correctly exited 1 because mandatory scope/review/matrix gates remain open. The pack result timestamp is **2026-10-26T20:23:42.043Z**. Isolated Node **22.23.4 and 24.22.1 each passed strict compilation and 379 aggregate tests** after the test-fixture transport correction described below.

| Historical model command/report                   | Observed result and scope                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, typecheck/build | All exited 0 in the combined model checkpoint                                                                                                                           |
| `pnpm test`                                       | **379/379 passed**, including native-control/model scheduler, synchronization policy/validation and registration regressions                                            |
| `pnpm test:coverage`                              | **97.18% branches, 98.20% statements** across only config, Live protocol and memory store; excludes runtime/action/client and most project files                        |
| `pnpm test:e2e`                                   | **48 expected, 0 unexpected/skipped/flaky**, Chromium/Firefox/WebKit with 2 workers, including fixture keyboard/axe/CSP checks                                          |
| `pnpm test:pack`                                  | Seven tarballs inspected; successful npm and pnpm external strict compilation, real MVC/Live DI/guard/pipe/replay and Node-safe import consumers                        |
| Isolated runtimes                                 | Node 22.23.4 and 24.22.1 each passed strict compilation and all 379 aggregate tests; full three-browser server/consumer matrices were not repeated under these binaries |
| `pnpm size:check`                                 | **66,354 raw bytes, 17,828 summed per-module gzip bytes across 9 modules**, below 35KiB gzip budget excluding Alpine/maps; not measured HTTP transfer                   |
| Docs, ledger, HBS microbenchmark, audit           | All exited 0; audit reported no known vulnerabilities, docs/ledger do not imply product acceptance, benchmark is not an application comparison                          |
| `pnpm release:check`                              | Correctly exited 1; mandatory master scope, matrix and independent review remain incomplete                                                                             |

The [registration checkpoint summary](registration-checkpoint-evidence-2026-10-26.json) preserves the earlier full runner at **2026-10-26T14:14:12.280Z**. Historical [foundation](checkpoint-evidence-2026-10-26.json) and [event](event-checkpoint-evidence-2026-10-26.json) snapshots remain distinct. The following table retains the historical registration checkpoint for comparison; it is not the current model result.

| Command/report                                    | Observed result and scope                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, formatting, lint, typecheck/build | All exited 0 in the registration runner                                                                                                                                            |
| pnpm test                                         | **249/249 passed**, including 14 Express/Fastify registration/context/shutdown regressions                                                                                         |
| pnpm test:coverage                                | 74 tests; **97.18% branches, 98.20% statements** across only config, Live protocol and memory store; registration/runtime and most project files are outside this measurement      |
| pnpm test:e2e                                     | **36 expected, 0 unexpected/skipped/flaky** across Chromium, Firefox and WebKit; fixture keyboard/axe/CSP checks passed                                                            |
| pnpm test:pack                                    | Seven tarballs inspected; npm and pnpm external consumers strict-compiled declarations and exercised real MVC/Live DI/guards/pipes/replay plus Node-safe imports                   |
| Additional runtimes                               | Windows Node 22.23.4 and 24.22.1 each passed strict compilation and the 249-test aggregate; this does not repeat the complete three-browser web-server matrix under those binaries |
| pnpm size:check                                   | 49,839 emitted custom-client bytes; 13,388 summed per-module gzip bytes versus 35KiB budget, excluding Alpine/maps; not measured HTTP transfer                                     |
| Docs and ledger                                   | Linked documentation snapshots and bookkeeping integrity passed; neither accepts the whole product                                                                                 |
| Benchmark                                         | 1,000 cached-HBS adapter iterations; no comparative application/load claim                                                                                                         |
| Dependency audit                                  | Exited 0 with no known vulnerabilities; consumers still need patched Multer resolution until upstream updates                                                                      |
| Release check                                     | Correctly exited 1: full master phases/requirements, matrix and review evidence remain incomplete                                                                                  |

An earlier registration runner stopped after a Windows Playwright trace-file EBUSY teardown failure during concurrent activity: 35 browser passes and one failure. The complete sequential rerun passed. No tests or accessibility rules were excluded. Fixture checks do not certify universal accessibility, independent security review or absence of undiscovered bugs.

Earlier model attempts also retain failures: one reached 47/48 browser passes before a WebKit throttle fixture raced automation IPC; another reached 46/48 passes before a Firefox page-fixture timeout and a WebKit in-flight assertion raced a real 200ms action. The throttle fixture now dispatches within one browser event turn, and in-flight assertions gate the actual server response instead of assuming a short timing window. Browser workers are 2. The complete combined runner subsequently passed; no real action/response was replaced with a fabricated success.

An earlier isolated Node 24.22.1 run reached 378/379 aggregate passes when fetch rejected an OS-assigned reserved ephemeral port in the Fastify shutdown fixture. The request rejection also caused a 15-second fixture admission wait timeout and unhandled rejection. This test-transport/cleanup failure did not establish a product defect. The test now uses a real node:http request with fail-fast gate waits and guaranteed cleanup; fresh host checkpoint and isolated Node 22/24 compilation/aggregate checks subsequently passed.

The first rendering aggregate attempt passed 425/433 tests; eight model-lifecycle setup hooks timed out because their fixture asset allowlist omitted the new `loading.js` import. The allowlist was fixed without disabling tests. A new WebKit replacement-focus assertion assumed mouse activation would focus a button; it now explicitly establishes keyboard focus and presses Enter. The corrected scenarios subsequently passed in the complete host checkpoint. These fixture corrections do not fabricate server responses or claim a product defect from an invalid fixture premise.

A later attempt passed 444/444 aggregate tests and 56/57 browser checks. Its WebKit event case used an automation double-click that exceeded the 100ms debounce window, producing two legitimate actions. The fixture now dispatches its pair in one browser turn; a subsequent complete runner passed 444/57 before the input-type regression was added.

Internal review then found a real caret defect in ordinary morphing: a retained focused text input could become a number, email or file input, after which restoring its old caret threw `InvalidStateError` before the client advanced its revision. All three new Chromium regressions failed before the fix. Selection capability is now checked after morphing; the entire 12-case lifecycle suite passes. A real Nest text/number switching flow also passes across all three browser engines and successfully invokes a subsequent action. Final aggregate/browser totals are 447/60, with both isolated runtime reruns green. This was a scoped internal review, not independent security approval or completion of the full native-input matrix.

Further review after the initial 503/72 checkpoint found a radio-group defect: distinct unresolved `form` targets were incorrectly treated as separate native groups. Three new Chromium regressions failed before correction. Grouping now uses actual form owners and projects detached incoming references into the retained document, including null, internal, external and inherited owners. The expanded focused native corpus passes 39/39 and actual Nest native scenarios pass 15/15 across three browsers. The [initial native snapshot](native-initial-checkpoint-evidence-2026-10-27.json) preserves the earlier 503/72 result; it does not validate this later source. The final combined 511/75 checkpoint and both isolated 511-test runtime runs passed after this correction.

## D. Documentation

Root [README](../../README.md), every package README, ten ADRs, architecture records, [default Live setup](../guides/default-live-setup.md), [Live protocol](../guides/live-protocol.md), [native controls/ownership](../guides/native-controls.md), [native reset](../guides/form-reset.md), [wrapper-only ignore](../guides/ignore-self.md), [request lifecycle](../guides/request-lifecycle.md), [client asset hosting/migration](../guides/client-assets.md), [third-party notices](../../THIRD_PARTY_NOTICES.md), [hardening](../security/hardening.md), partial [ASVS mapping](../security/asvs-traceability.md), preliminary [security review](../security/security-design-review.md), community policies and [changelog](../../CHANGELOG.md) exist. The production docs website and guides for undelivered systems remain required work.

## E. Artifacts

Current multiple-select checkpoint: seven 0.1.0-alpha.0 tarballs under artifacts/packages, verified in four external full/minimal npm/pnpm consumers at **2026-10-29T08:21:07.770Z**. The [snapshot](multiple-select-checkpoint-evidence-2026-10-29.json) records inventories and SHA-256 hashes. Built docs remain local snapshots under artifacts/docs. No publication, remote push, SBOM or provenance attestation was produced.

Historical retained-editor checkpoint: seven 0.1.0-alpha.0 tarballs under artifacts/packages, verified in four full/minimal npm/pnpm consumers at **2026-10-29T07:44:08.894Z**. The [editor snapshot](editor-selection-checkpoint-evidence-2026-10-29.json) records hashes and inventories. Local docs snapshots remain under artifacts/docs. Publication, SBOM and provenance attestation remain unperformed.

Historical visibility checkpoint: seven 0.1.0-alpha.0 tarballs under artifacts/packages, verified in four full/minimal npm/pnpm consumers at **2026-10-28T18:54:55.530Z**. The visibility snapshot records hashes and inventories. Documentation snapshots remain local under artifacts/docs. No publication, remote push, SBOM or provenance attestation was performed.

Historical focus checkpoint: seven 0.1.0-alpha.0 tarballs under artifacts/packages, verified at **2026-10-28T04:54:02.190Z** in four external consumers. The saved focus snapshot records inventories and SHA-256 hashes. Built docs remain local snapshots under artifacts/docs; publication, SBOM and provenance attestations remain unperformed.

The historical default-setup pack report at **2026-10-28T03:01:55.462Z** verifies all seven 0.1.0-alpha.0 archives in four full/minimal npm/pnpm consumers. Tarballs remain under `artifacts/packages`, with built declarations, runtime modules, READMEs and licenses; the umbrella includes its third-party notice. Current mutable reports/logs are under `artifacts/reports`; docs snapshots are under `artifacts/docs`. That docs build produced 41 snapshots. No SBOM/provenance attestation or public release was produced.

Version 0.1.0-alpha.0 tarballs are under artifacts/packages. The [asset summary](asset-hosting-checkpoint-evidence-2026-10-27.json) preserves seven archives verified in four external full/minimal npm/pnpm consumers at **2026-10-27T19:09:09.215Z**, including inventories, hashes and public entry points. The umbrella archive includes its third-party notice. The historical [reset summary](form-reset-checkpoint-evidence-2026-10-27.json), [transport summary](transport-checkpoint-evidence-2026-10-27.json), [self-ignore summary](ignore-self-checkpoint-evidence-2026-10-27.json), [native summary](native-checkpoint-evidence-2026-10-27.json) and [rendering summary](rendering-checkpoint-evidence-2026-10-27.json) retain their original package evidence. Mutable reports/logs are under artifacts/reports; the asset host docs build produced 40 readable snapshots. No publication, SBOM, provenance attestation or approved release manifest is claimed.

## F. Known issues and unmet gates

Full Live behavior, forms/uploads, alternative engines, official Inertia React/Vue/Svelte integrations, hybrid islands, universal actions, realtime/distributed stores/cache/jobs, extensions and CLI remain unmet. Linux remains unverified; the earlier local Docker daemon was unavailable. Full Nest/platform/browser/fault matrices, project-wide coverage, mutation/fuzz/long-memory/load tests and independent review remain open.

Memory state/sample sessions are single-process without durable exactly-once business guarantees. Hosts own authentication, principal/tenant selection, logout revocation, body limits, production sessions, renderer lifecycle, TLS/proxy policy and business transactions. Synchronization is a separate write surface: policies required for every edit must use `$sync` authorization or component/global scope, rather than an action-method guard. Nested paths, checkbox selection groups and file models remain unsupported; native multiple selects support bounded flat arrays to their documented limits.

Loading effects and marker consistency checks do not authorize requests. Replacement deliberately loses removed local state and does not provide official island teardown/hydration or a complete nested-server component API. Unbound multiple-select preservation is distinct from explicit bounded array models, which require strict catalogs and host item validation. Cross-owner native radio grouping, external widgets and teleport behavior remain unsupported or unverified. Complete concurrency, input/modifier, cleanup, focus and screen-reader acceptance remains open beyond the scoped fixtures.

Self-ignore retains wrapper attributes only; descendants stay Live-owned, and the Alpine adapter still requires whole-ignore isolation. Native input/textarea/select/option/optgroup elements, editable wrappers and renderer roots cannot use `.self`. Retained wrapper directives cannot be reconfigured without replacement. Corrected host and isolated runtime checks pass for this slice; the full renderer, native-input, accessibility and platform matrices remain open.

The browser deadline cannot preempt synchronous JavaScript or stop already-running server business work. A custom transport must release its own external resources. Bounded response bytes do not establish a process-wide memory guarantee. Uncertain failures require authoritative reconciliation rather than replaying queued mutations, even when a cancellation promise resolves. Corrected host and both isolated runtime checks pass; full transport/fault/platform acceptance remains open.

Asset URLs are content-addressed snapshots, not a CDN retention or SRI solution. A restart does not retain earlier versions, so deployments must preserve old assets or reload old pages. Host middleware/interceptors/filters control final responses; public asset responses must remain free of private props/session material. Default bootstrap delegates fresh Alpine startup; a host-hidden previously started instance cannot be detected via public APIs. Disposed/failed documents require reload; persisted lifecycle tests do not prove every navigation qualifies for BFCache. The complete production deployment matrix remains open.

## G. Owner release steps

After all gates pass: verify package/scope ownership, trademark/license review, official repository/maintainer/private security contacts and protected trusted-publishing controls; approve version/tag; review artifacts/security evidence; explicitly authorize publication. No remote push, namespace reservation or npm publication occurred.

## H. Maintenance

The unreleased version is 0.1.0-alpha.0. Public changes need tests, docs, a Changeset and migration review. Local commits 2bb6274, 25b45d0 and 53eb436 preserve the foundation, event and registration slices; model work has tracked checkpoint evidence. Finish mandatory implementation and adopt supported release/security windows before public distribution.
