---
'@nestvexa/client': minor
---

Realtime transport `auto` (the default) now negotiates at runtime: it starts
with SSE and falls back to long-polling for the controller lifetime when SSE
fails twice before its first `ready` event or stays silent for 10 s (for example
behind a buffering proxy). Reconnect backoff resets only after a successful
`ready`/poll instead of on every delivered event, and a circuit breaker
switches to one probe every five minutes after ten consecutive failures. The
controller exposes the resolved `transport`.
