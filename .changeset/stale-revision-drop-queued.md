---
'@nestvexa/client': patch
---

After a `409 STALE_REVISION`, calls already queued behind the refused one are dropped unsent (rejected with `ABORTED`) instead of being sent with the refused revision; only the single resync follows, and new actions afterwards work normally.
