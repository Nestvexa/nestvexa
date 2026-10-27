---
'@nestvexa/client': minor
---

Bound each dispatched request's fetch and response body by a configurable deadline and a 2MiB byte limit. Strict JSON media type and UTF-8 checks precede response application. Expose safe `NETWORK`/`TIMEOUT` failures and `LiveHttpError.status` without copying private transport errors or response bodies.

Stop subsequent transport after an uncertain result, including queued and nested work, while retaining local drafts, state access and enhanced form prevention. Recovery requires trusted host reconciliation or reload; no mutation is automatically retried. Disposal/removal now settles uncooperative requests promptly under the existing cleanup cancellation contract.
