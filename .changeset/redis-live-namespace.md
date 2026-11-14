---
'@nestvexa/realtime-redis': minor
---

`RedisLiveStore` gains a `namespace` option (per-tenant key spaces, hashed user
index, `revokeTenant` and `revokeUser`), an attempt fence so an action whose
commit was never recorded (crash, outage, lapsed lease) invalidates its entry
instead of running twice, and maps Redis I/O failures to
`503 STORE_UNAVAILABLE` instead of generic errors.
