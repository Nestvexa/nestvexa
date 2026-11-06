---
'@nestvexa/realtime-redis': minor
---

Add `RedisJobQueue`, a durable `JobQueue` for `JobRunner` (sorted-set indexes, `WATCH`/`MULTI`/`EXEC` compare-and-set on every state change, lease reclaim for crashed workers, owner-scoped idempotency keys, validated records), and `RedisPresenceStore` for presence across replicas (per-replica entries with `PX` expiry, so a crashed replica drops out within one TTL). Both are exported from `@nestvexa/realtime-redis/realtime` and use the built-in RESP client.
