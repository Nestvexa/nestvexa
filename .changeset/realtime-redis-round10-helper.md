---
'@nestvexa/realtime-redis': minor
---

Add `redisRealtime(options)` to `@nestvexa/realtime-redis/realtime`: one Redis
configuration that returns the Redis broker and, by default,
`RedisPresenceStore` presence (`presence: false` opts out), for spreading into
`RealtimeModule.forRoot`.
