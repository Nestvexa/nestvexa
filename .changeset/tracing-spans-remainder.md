---
'@nestvexa/observability': minor
'@nestvexa/live': minor
'@nestvexa/realtime': minor
'@nestvexa/vite': minor
'@nestvexa/inertia': minor
---

More OpenTelemetry-shaped spans through structural `instrumentation` hooks:
`nestvexa.live.admit` (request admission with closed error codes),
`nestvexa.live.hydrate`, `nestvexa.live.hook`, the morph HTML size on
`nestvexa.live.action`, `nestvexa.realtime.publish|subscribe|connection|deliver`,
`nestvexa.asset.serve` (`viteStaticMiddleware`), `nestvexa.ssr.render` (Inertia
SSR), `nestvexa.request` with request ids (`requestTracingMiddleware`) and
`nestvexa.guard` (`traceGuard`). Attributes are ids, kinds, sizes and closed codes
only.
