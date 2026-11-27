---
'@nestvexa/realtime-redis': minor
---

Add `RedisActionIdempotencyStore` (`@nestvexa/realtime-redis/actions`), a shared
`ActionIdempotencyStore` for `@nestvexa/actions`: atomic `SET NX PX` claims with
a renewed lease, owner-checked completion and abandon, outcome retention for the
runtime TTL and fail-closed behaviour on Redis errors, corrupt records and failed
completions. A retried idempotent action now replays across replicas and
restarts. The `@nestvexa/live` peer is now optional; the new `/actions` and
`/cache` entry points never load it.
