---
'@nestvexa/realtime-redis': minor
'@nestvexa/uploads': minor
'@nestvexa/ai': minor
'@nestvexa/mail': minor
---

Add circuit breakers to the optional services. Redis connections, S3 storage,
the clamd scanner, AI providers and mail transports now fail fast while their
service is down, with no network call, and recover through a single probe
after a cooldown. Configure with `circuitBreaker: { failureThreshold,
cooldownMs }` or turn off with `circuitBreaker: false`. Redis connection
attempts are now bounded by `commandTimeoutMs`. Mail sends get a
`sendTimeoutMs` (default 30000). A Redis command no longer waits forever when
the server closes the connection between connect and write.
