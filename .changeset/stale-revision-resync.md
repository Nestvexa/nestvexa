---
'@nestvexa/client': patch
'@nestvexa/live': minor
---

Honor the `resync` recovery of `409 STALE_REVISION` instead of suspending the
component. The server marks that reply with `x-nestvexa-recovery: resync` and
accepts a `$sync` marked `x-nestvexa-resync: 1` without updates, which
re-renders the caller's current state at its current revision. The client sends
one such resync. It does not replay the refused call and keeps local drafts for
the next request. If the resync is itself stale, the component suspends.
