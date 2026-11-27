---
'@nestvexa/cache': minor
---

`CacheStore` gains two optional methods for shared stores: `tagMarker(tags)`,
whose result `Cache` passes back to `set(key, entry, marker)` so a store can
discard a value whose computation overlapped an invalidation on another
instance (`set` may return `false`, counted as `discarded`), and
`lock(key, ttlMs)` for cross-process single flight. `new Cache({ lock })`
configures the lock lease and the wait for another process's value
(`{ ttlMs: 10000, waitMs: 3000 }` by default; `false` keeps single flight per
process). Memory stores are unchanged.
