---
'@nestvexa/live': minor
'@nestvexa/client': patch
'@nestvexa/observability': patch
---

Read-only refresh: a `$sync` with `x-nestvexa-resync: 1` and no updates now renders
the stored state at its stored revision without a store transaction. A render that
would change stored state or the child tree fails with `409 REFRESH_CONFLICT`
(`x-nestvexa-recovery: commit`); `x-nestvexa-resync: commit` is the explicit
committing resync. The browser client uses the read-only refresh for realtime
invalidations and `STALE_REVISION` recovery and commits once on a conflict.
Inspectors report the new `refresh` render cause. See ADR 0036.
