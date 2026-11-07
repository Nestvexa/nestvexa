---
'@nestvexa/inertia': patch
---

JSON page responses now list every content-selecting request header in `Vary`
(`X-Inertia`, `X-Inertia-Version`, the partial-reload, reset, error-bag,
merge-intent and except-once headers), and version-mismatch `409` responses
vary on `X-Inertia-Version` too. Before, a shared cache keyed on `Vary:
X-Inertia` alone could store one visitor's partial reload and replay it to
every later Inertia visit of that URL.

`HttpSsrGateway` refuses a configured URL with credentials, a query or a
fragment, no longer follows redirects from `/health`, and reads `/render` and
`/health` bodies with a hard byte limit, cancelling the stream instead of
buffering an oversized or endless response first.
