---
'@nestvexa/live': minor
'@nestvexa/realtime-redis': minor
---

Idempotent replays and identity-scoped action locks now work across replicas
when the Live store implements the new structural `LiveActionCoordination`
interface. `RedisLiveStore` implements it: replay records are sealed with
AES-256-GCM under a key derived from the original request (the store never
sees responses, tokens or identities) and identity locks are expiring
`SET NX PX` leases released by compare-and-delete. `MemoryLiveStore` keeps the
process-local behavior.
