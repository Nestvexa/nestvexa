---
'@nestvexa/inertia': minor
---

Add `@nestvexa/inertia`, an Inertia.js v3 server adapter for Nest controllers on
Express and Fastify, verified against the v3 protocol documentation, the
official `@inertiajs/core`/`@inertiajs/react` 3.10.0 clients and the reference
Laravel adapter. It provides `InertiaModule.forRoot/forRootAsync`,
`@InertiaPage`, `InertiaService`, lazy `always`/`optional`/`defer`/`merge`/
`deepMerge`/`once`/`scroll` props, shared props, flash data, validation errors
with error bags, asset-version 409s, 303/409 redirects with an origin allowlist,
history flags, big-integer markers, multiple roots, HBS root views and an SSR
renderer contract with graceful fallback. Malformed `X-Inertia-*` headers are
rejected and page JSON is escaped for script embedding.
