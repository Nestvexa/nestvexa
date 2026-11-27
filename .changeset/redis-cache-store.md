---
'@nestvexa/realtime-redis': minor
---

Add `RedisCacheStore` (`@nestvexa/realtime-redis/cache`), a shared `CacheStore`
for `@nestvexa/cache`: hashed keys with `PX` expiry, a tag index with
per-tag invalidation counters (an invalidation is visible on every instance at
once), marker-checked writes that discard values computed across another
instance's invalidation, a cross-process stampede lock, `maxEntryBytes` and
`maxEntries` bounds, and refusal of Live snapshots, CSRF tokens and signed
island props.
