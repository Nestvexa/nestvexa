# 0020 — Live client size budget revision for Phase 4 parity

Status: accepted for the current experimental implementation. Supersedes the
budget value (not the bundling strategy) of [ADR 0015](0015-production-client-bundle.md).

## Context

The master specification proposes an _initial_ gzip cap "e.g. 35 KB" for the
custom Live runtime, to be adjusted "with ADR and measurements". ADR 0015 kept
35 KiB (35,840 bytes) while moving to one canonical minified entry. Phase 4 then
added nested child roots (stub retention, refresh replacement, grafting), browser
event delivery, modelable propagation, lazy loading, renderless acknowledgements,
sorting and streams. All of it is reachable from the single public entry, so the
measurement correctly grew.

Measurements on 2026-11-01 (Windows, Node 24, `pnpm size:check`, gzip level 9):

| Artifact                                                            | Minified bytes | Gzip bytes |
| ------------------------------------------------------------------- | -------------- | ---------- |
| Nestvexa Live runtime (`packages/client/dist/index.js`)             | 113,416        | 36,522     |
| Alpine CSP build (`@alpinejs/csp` `module.esm.min.js`, for context) | 72,226         | 23,867     |

## Decision

Set the custom-runtime budget to **48 KiB (49,152 bytes)** gzip, measured exactly
as before: every byte reachable from the canonical entry, excluding Alpine, the
Alpine adapter, source maps and HTTP framing. The budget remains a hard failing
gate in `scripts/size.mjs` and every checkpoint.

The headroom is reserved for the remaining Phase 4 browser features in the
specification's directive matrix (`nv:navigate`, optimistic updates). Any further
increase requires a new ADR with fresh measurements.

## Rejected alternatives

- **Keep 35 KiB by excluding features from the measurement**: understates real cost.
- **Split optional features into lazily imported chunks now**: needs a tested
  installation, CSP and ownership-registry contract (ADR 0015); it remains the
  preferred path if the runtime approaches the new budget.
- **Remove validation to save bytes**: rejected; the validation is the security
  boundary for server-supplied markup and markers.

## Consequences

Default pages transfer roughly 12 KiB more compressed JavaScript than the original
proposal allowed. The runtime is still a single cached, content-addressed asset.
No public API changes.
