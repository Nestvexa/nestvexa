---
'@nestvexa/live': minor
'@nestvexa/realtime-redis': patch
---

Live can enforce its security policies through a kernel policy registry: with the
structural `policies` option (for example `SecurityPolicyRegistry`), Live registers its
origin, CSRF, action-authorization and snapshot policies under `policyOwner` (default
`live`) and asks the registry for every decision. `requestContext` adds
`nestvexa.request_id` to Live spans. `429 RATE_LIMIT` responses now carry `Retry-After`.
Host `authorize` callbacks must return a literal `true` (truthy non-boolean values now
deny). `MemoryLiveStore` and `RedisLiveStore` expose `ttlMs`.
