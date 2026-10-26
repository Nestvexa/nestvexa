# ADR 0004: Explicit renderer ownership and document transitions

Date: 2026-10-25. Status: **MVC separation implemented; Live/client/island/Inertia decisions planned and unverified**.

## Decision

Each page root has one authoritative renderer and an explicit app ID/asset entry. MVC uses Nest `@Render` and an engine adapter. A Live component may morph its own subtree while preserving declared ownership boundaries. A React, Vue or Svelte island owns its entire mounted root; parent Live updates must retain that node without reconciling its children. Nested Live roots similarly own their descendants. A node cannot be concurrently owned by a framework virtual DOM and Live morphing.

Cross-renderer or incompatible app-root navigation performs a full-document visit. Same-root enhanced navigation can be introduced only when asset version, lifecycle, history and teardown contracts are verified. Inertia remains an independent official-client protocol path, not a synonym for a Live fragment response. The v3 server adapter, framework clients and SSR are not implemented at this checkpoint.

The initial client scope is deliberately explicit: `nv:click`, `nv:model` and `nv:submit` use a strict identifier/data grammar. Attribute values are not evaluated as arbitrary JavaScript. Other requested directives remain unmet until their behavior, modifiers, cleanup and browser tests exist. An unsupported directive must not silently appear to work. Alpine integration requires one installation owner and separate lifecycle proof; the default Alpine expression evaluator cannot be claimed compatible with a no-unsafe-eval CSP.

Future island descriptors resolve only registered components to trusted manifest entries. Client-safe props use context-correct encoding and bounded size. Mount strategies must own cancellation, teardown and listener cleanup. Trusted server HTML is distinct from user HTML; text streams use text nodes by default. React/Vue/Svelte-specific hydration must be tested independently.

## Rejected alternatives and tradeoffs

Allowing all frameworks to patch a shared root was rejected because mutation ordering, lifecycle and state ownership cannot be guaranteed. A universal SPA navigation bridge was rejected until independently proven. Automatically evaluating directive strings would simplify examples but creates an unacceptable code-execution surface. Explicit app roots and safe document transitions cost reloads when crossing boundaries, while keeping ownership reviewable.

Failure modes include detached listeners, leaked framework roots, focus/caret loss, stale responses overwriting input, duplicate Alpine initialization and hydration mismatch. Replacement/removal must call the child owner's teardown exactly once before freeing its root; reinsertion must not reuse stale subscriptions.

## Evidence and compatibility

[MVC browser tests](../../tests/browser/mvc.spec.ts) cover document navigation and basic keyboard/no-JavaScript behavior only. Morph, strict directive grammar, local Alpine retention, all-framework coexistence, island removal/reinsertion, SSR hydration and heterogeneous navigation tests remain release gates. No current package README may list these planned modes as shipped.
