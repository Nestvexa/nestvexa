---
'@nestvexa/cache': minor
---

`RenderCache` for rendered HTML: keys always include component, revision,
renderer, locale, tenant, permission scope and asset version; private per-user
HTML is never stored unless `cachePrivate` is set. Values carrying Live
snapshots, CSRF tokens or signed island props are refused with
`CacheRefusedError`. New `tenant` scope, `Cache` options object with `onEvent`
telemetry and `instrumentation` spans, `lookup()` statuses, asynchronous
`CacheStore` support, degraded behaviour on store failures, and computations
overlapping an invalidation are no longer stored. Stale-while-revalidate is
allowed for public and tenant scopes only; vary values must be finite.
