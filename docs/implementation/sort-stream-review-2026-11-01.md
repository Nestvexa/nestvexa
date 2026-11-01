# Sorting and streaming review — 2026-11-01

Internal read-only review by a separate coding agent, followed by implementation
and regression tests. This is not an independent security audit or whole-phase
acceptance. The source-bound checkpoint report identifies final executed gates.

| Finding                                                                                                                                                            | Severity | Correction                                                                                                                                           | Regression evidence                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A custom async iterator's `return()` or its getter could throw during cleanup and create an unhandled rejection.                                                   | P1       | Consume failure from the entire cleanup operation, then release its capacity lease unconditionally. Private cleanup details are not sent to clients. | [Express/Fastify custom iterators](../../tests/live-stream.test.ts)                           |
| A new `aria-labelledby` target in a detached server-render preview could not resolve through the current document, suspending an otherwise valid component update. | P1       | Resolve labels inside the actual component validation subtree before falling back to external document labels.                                       | [Real HBS relabeling, sorting, focus and retained identity](../../tests/browser/sort.spec.ts) |
| A stream target inherited `contenteditable="plaintext-only"` but passed the exclusive noneditable-target check.                                                    | P2       | Conservatively reject any contenteditable ancestor, including explicit false/editor containers, and document the boundary.                           | [Stream target rejection corpus](../../tests/client-stream.test.ts)                           |

Other defects found during implementation were corrected: server morphs removing
the client-owned `draggable` attribute; a demo module being loaded on every page;
and fixture focus loss when modelling an acknowledged reorder with raw DOM
append operations. Production drag attributes now reconcile around morphs, the
demo script loads only on `/activity`, and public browser tests exercise real
Nest responses without weakening focus assertions. Dynamic label nodes and sort
handles use explicit stable identities where DOM retention is required.

The streaming test fixture disables HTTP pooling after diagnostics identified
zero-byte speculative client TCP connections following cancellation. It does not
force-close active streams to hide teardown problems. Separate tests exercise
actual cancellation before Nest HTTP adapter shutdown, quotas across component
instances, stale revisions, revocation during chunk production, and a producer
ignoring cancellation while retaining its capacity lease.

Review scope excluded the remaining Phase 4 mechanisms, distributed services,
third-party engines, Inertia, uploads, forms and external deployment hardening.
Those requirements remain in the [feature ledger](feature-ledger.md).
