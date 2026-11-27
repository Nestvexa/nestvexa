---
'@nestvexa/realtime': minor
'@nestvexa/realtime-redis': patch
'@nestvexa/uploads': patch
'@nestvexa/ai': patch
'@nestvexa/mail': patch
---

`RespRealtimeBroker` (`RedisRealtimeBroker`) now has the shared circuit breaker
and timeouts: `commandTimeoutMs` (default 5000 ms) bounds connecting and each
PUBLISH/PING reply, and `circuitBreaker` (default 5 failures, 1 s cooldown;
`false` disables it) makes `publish`, the new `ping()` and a `subscribe` that
needs a new connection fail fast with `CircuitOpenError` while Redis is down.
The subscriber reconnect is the half-open probe and restores every channel.
New `circuit` and `subscribed` getters support health checks, and
`CircuitOpenError` is exported from `@nestvexa/realtime`. The hub now shares
one in-flight broker subscription between concurrent connections, refuses all
of them with `503 BROKER_UNAVAILABLE` when it fails, and retries it for the
next connection. The other packages only update the shared breaker file's
header comment, which now lists the fifth copy.
