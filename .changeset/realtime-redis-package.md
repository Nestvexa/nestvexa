---
'@nestvexa/realtime-redis': minor
---

New optional package with Redis adapters for multi-replica deployments:
`RedisLiveStore` (shared Live state with hashed keys, a per-identity index,
TTL, `SET NX PX` transaction leases, `WATCH`/`MULTI`/`EXEC` compare-and-set
commits, validated records and optional AES-256-GCM at rest), a
zero-dependency `RespConnection`, and `RedisRealtimeBroker` from the
`/realtime` entry point. Single Redis primary only; Redis Cluster is not
supported.
