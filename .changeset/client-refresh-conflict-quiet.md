---
'@nestvexa/client': patch
---

A read-only refresh refused with `409 REFRESH_CONFLICT` no longer drops calls queued
behind it and is no longer reported as a `nestvexa:error`; the queued committing
resync renders the result.
