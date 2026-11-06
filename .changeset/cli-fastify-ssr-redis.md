---
'@nestvexa/cli': minor
---

Support Fastify hosts in `init` (`@fastify/cookie` + `@fastify/session`), `add engine|inertia|islands|uploads|realtime` and every generator; `add redis` wires `@nestvexa/realtime-redis` (Live store and realtime broker behind `REDIS_URL`); generated Inertia roots get SSR entries built by `build:<framework>` and rendered in production (`NESTVEXA_ASSETS=build` for development); the doctor checks Fastify sessions, `REDIS_URL` and SSR bundles.
