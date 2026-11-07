# ADR 0004: Explicit renderer ownership and document transitions

Date: 2026-10-25; replacement/loading and self-ignore amendments 2026-10-27. Status: **MVC and an initial Live/client ownership slice implemented; complete acceptance, framework islands and Inertia remain unmet**.

## Decision

Each page root has one authoritative renderer and an explicit app ID/asset entry. MVC uses Nest `@Render` and an engine adapter. A Live component may morph its own subtree while preserving declared ownership boundaries. A React, Vue or Svelte island owns its entire mounted root; parent Live updates must retain that node without reconciling its children. Nested Live roots similarly own their descendants. A node cannot be concurrently owned by a framework virtual DOM and Live morphing.

Cross-renderer or incompatible app-root navigation performs a full-document visit. Same-root enhanced navigation can be introduced only when asset version, lifecycle, history and teardown contracts are verified. Inertia remains an independent official-client protocol path, not a synonym for a Live fragment response. The v3 server adapter, framework clients and SSR are not implemented at this checkpoint.

The client uses a strict identifier/data grammar for actions, primitive models and presentation directives. Attribute values are not evaluated as arbitrary JavaScript. An unsupported directive fails explicitly. The explicit Alpine adapter is installed by its host before Alpine starts; ignored local widgets have their own ownership. The sample uses Alpine's CSP build, without claiming the default expression evaluator works under a no-unsafe-eval CSP.

Normal keyed morphing retains stable ignored, nested Live and island marker nodes without reconciling their descendants. Incoming `nv:replace=""` on an owned inner container deliberately replaces its children, retaining and server-patching the wrapper. Incoming `.self` replaces the whole element. The component root and ownership-boundary node itself cannot carry replacement. Void/native control elements require `.self`. The incoming fragment chooses the mode; removing a replacement declaration permits ordinary morphing again.

An explicitly replaced ancestor may remove an ignored/nested/island descendant. Replacement therefore resets native/file selections, Alpine local state and custom widget state, and discards dirty field values when every original bound control is removed. It does not promise persistence across a deliberate reset. Before removing each outer element subtree, the client cancels event/model timers, detaches direct listeners, aborts nested client Live requests and releases ownership. Bubbling, noncancelable `nestvexa:before-remove` and `nestvexa:after-insert` events let host-owned widgets tear down or observe insertion. Descendants are included in their outer notification; retained keyed moves do not notify removal. `nestvexa:updated` follows Live reconciliation/discovery. Asynchronous third-party initialization and the full nested-server lifecycle remain outside this initial contract.

Loading presentation has one owner per DOM property. Component `aria-busy` belongs to the client; optional element-level loading effects use per-action counts that include queued work and the explicit `$sync` target. The closed grammar permits visibility, simple classes and four safe state attributes. Class/attribute effects restore captured baselines rather than enabling a server-disabled control. Conflicting bindings, root visibility and root `aria-busy` effects reject configuration before mutation. Loading effects are restored before server markup, on ownership/configuration changes and during disposal. These UI effects never authorize a request.

Future island descriptors resolve only registered components to trusted manifest entries. Client-safe props use context-correct encoding and bounded size. Mount strategies must own cancellation, teardown and listener cleanup. Trusted server HTML is distinct from user HTML; text streams use text nodes by default. React/Vue/Svelte-specific hydration must be tested independently.

## Rejected alternatives and tradeoffs

`nv:ignore.self` delegates a retained wrapper's attributes to a host widget while Live still owns its children. Same-node `nv:*` configuration is frozen; a changed key or ancestor replacement is required to reconfigure it. Competing attribute/model/loading/replacement effects, native control roots and editable/renderer roots reject setup. Switching between ordinary and self ownership deliberately replaces the wrapper and runs removal cleanup. Existing whole-ignore subtrees remain opaque until explicitly replaced.

A side-effect-free preflight projects retained wrapper attributes into an isolated incoming tree before preview validation or form-owner resolution. This costs an additional bounded clone for components containing self-ignore, but keeps retained IDs and directives consistent with actual DOM behavior. Merely skipping attribute assignment was rejected because raw incoming preview/form associations could disagree with the retained wrapper. The pure sibling matcher is shared by projection and patching to avoid divergent keyed/unkeyed decisions. These client ownership rules do not authorize a server action or roll back effects after abort.

Allowing all frameworks to patch a shared root was rejected because mutation ordering, lifecycle and state ownership cannot be guaranteed. A universal SPA navigation bridge was rejected until independently proven. Automatically evaluating directive strings would simplify examples but creates an unacceptable code-execution surface. Explicit app roots and safe document transitions cost reloads when crossing boundaries, while keeping ownership reviewable.

Always retaining a keyed node was rejected for explicit replacement: applications need an honest reset boundary for native and third-party DOM state. Preserving selected descendants inside a replaced ancestor was also rejected because it would make reset semantics depend on hidden renderer state. The cost is deliberate edit/focus/widget-state loss; ordinary morphing remains the choice when preservation matters. Treating removal notifications as cancelable was rejected because vetoed removal could diverge DOM, server revision and renderer ownership.

Blindly removing `disabled` or classes after a request was rejected because it can overwrite server/host state. Loading instead retains/restores baselines and rejects competing owners. This adds capture/cleanup bookkeeping and bounded target/class syntax; it does not add delays or arbitrary CSS/attribute expressions.

Failure modes include detached listeners, leaked framework roots, focus/caret loss, stale responses overwriting input, duplicate Alpine initialization and hydration mismatch. Replacement/removal must call the child owner's teardown exactly once before freeing its root; reinsertion must not reuse stale subscriptions.

The 2026-10-29 selection amendment retains native anchor/focus node references and offsets for one owned inner light-DOM editing host. Cloning a live Range was rejected because DOM mutation can adjust its endpoints; serializing HTML or remapping offsets into replacement nodes was rejected because that would invent rich-text state semantics and cross ownership/reset boundaries. Restoration is scoped to retained valid nodes, skips host callback overrides, and precedes explicit focus to handle WebKit's caret ordering. This adds request-local presentation bookkeeping without a dependency, public directive or server state field. Cross-editor/multi-range/plugin/shadow/iframe selection remains outside the contract. See [selection rules and regressions](../guides/focus-restoration.md#local-editable-selection).

## Amendment (2026-11-06): checkbox groups, nested paths and portals

Checkboxes whose field holds array state now form value groups with the same bounds,
uniqueness, casts and membership projection as multiple selects; a single checkbox stays
boolean. Model and binding names accept dotted paths of up to eight identifier segments;
the client keeps one draft per path and sends the whole top-level field, and the server
accepts it only through a `@State({ writable: [...] })` nested allowlist compared with
the stored value. File inputs remain outside `nv:model` (use `nv:upload`), and
`contenteditable` is not modelled. Rejected: array-index paths and deep generic setters
(ambiguous identity under reordering), and per-leaf patches on the wire (a protocol change
and a second authorization surface).

Portals: there is no `nv:teleport`. Server-rendered Live markup moved outside its root by
another library is not owned (its directives are inert) and the next morph re-renders the
server copy; portal targets belong inside an `nv:ignore` subtree, where Alpine or an
island owns them. Island subtrees keep their DOM across morphs and are torn down with an
enclosing `nv:replace`. See [nested models](../guides/nested-models.md) and the
ownership rows of the [directive matrix](../reference/directive-matrix.md).

## Evidence and compatibility

The multiple-select amendment uses bounded unique scalar arrays with ordered equality and value-membership projection, preserving array order until the next native control read. Arbitrary deep equality, generic object setters, ambiguous duplicate/coerced option values and checkbox/file arrays were rejected to keep state shape and DOM projection deterministic. Aliases require identical array shape/cast but may expose different catalogs; unknown newer values remain in state for server validation. Native reset aliases require equal ordered defaults. This adds bounded per-control validation work and changes previously rejected multiple model controls into supported explicit bindings; see [rules and tests](../guides/multiple-select.md). A two-pass TypeScript build strips source comments only from browser JavaScript, retaining declaration JSDoc and maps to stay inside the unchanged runtime size budget.

The [self-ignore lifecycle cases](../../tests/client-ignore-self.test.ts), [mixed sibling permutation invariant](../../tests/client-replace.test.ts), [closed parser cases](../../tests/client.test.ts) and [real Nest self-ignore scenarios](../../tests/browser/ignore-self.spec.ts) exercise the wrapper contract. The [wrapper guide](../guides/ignore-self.md) documents unsupported native/editor placements, including a non-editable wrapper below an editable ancestor. Scope and executed outcomes belong to the implementation checkpoint; these fixtures do not establish official framework or complete external-widget lifecycle parity.

[MVC browser tests](../../tests/browser/mvc.spec.ts), [Live browser fixtures](../../tests/browser/live.spec.ts), [model lifecycle tests](../../tests/client-model-lifecycle.test.ts), [loading tests](../../tests/client-loading.test.ts), [replacement tests](../../tests/client-replace.test.ts), [rendering lifecycle tests](../../tests/client-rendering-lifecycle.test.ts) and [loading/replacement browser scenarios](../../tests/browser/replacement-loading.spec.ts) define the initial boundaries. Controlled transport fixtures prove client behavior rather than server protocol conformance. Execution results must be recorded in the implementation checkpoint before acceptance; source/test presence is not a passed gate. All-framework coexistence, official island removal/reinsertion, complete nested-server behavior, SSR hydration and heterogeneous enhanced navigation remain unmet. No package README may list those systems as shipped.

## Status update (2026-11-07)

The ownership rules are unchanged. Two systems the previous paragraph listed as
unmet now ship as experimental alpha packages. Their README status lines are
therefore accurate:

- Framework islands: `@nestvexa/islands` mounts React, Vue and Svelte islands
  beside Live components, with SSR and hydration
  ([ADR 0024](0024-frontend-adapters-and-ssr.md)). `tests/browser/islands.spec.ts`
  covers independent mounting across Live updates, removal and reinsertion
  (cleanup and exactly one remount), failure isolation, hydration mismatch
  reports and navigation cleanup. `tests/browser/islands-vite.spec.ts` covers
  the Vite path.
- Inertia: `@nestvexa/inertia` with the React, Vue and Svelte adapters
  ([ADR 0018](0018-inertia-server-adapter.md)). `tests/browser/inertia-mixed.spec.ts`
  checks that roots of different frameworks load only their own bundles and
  that cross-root navigation is a full page load.
- Mixed pages: `tests/browser/integration-matrix.spec.ts` (VISION-035) mounts
  islands of all three frameworks beside a Live widget on one page.

Still open: heterogeneous enhanced navigation (Live and Inertia sharing one
client-side navigation) and complete external-widget lifecycle parity.
