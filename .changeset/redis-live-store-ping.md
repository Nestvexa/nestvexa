---
'@nestvexa/realtime-redis': minor
---

`RedisLiveStore` gains `ping()` and a `circuit` getter for readiness probes.
`ping()` round-trips a `PING` on the command connection and rejects with the
retryable `503 STORE_UNAVAILABLE` error while Redis is unreachable or the
circuit is open. `examples/distributed-live` now serves separate `/healthz`
(liveness) and `/readyz` (readiness: Live store and realtime broker) probes.
