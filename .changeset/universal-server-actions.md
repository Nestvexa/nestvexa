---
'@nestvexa/actions': minor
---

Add `@nestvexa/actions`: explicit, authorization-first server actions for NestJS.
`@ActionGroup`/`@ServerAction`/`@ActionInput` plus `ActionsModule.register` and
`registerAsync` generate one real Nest controller per group, so global, class and
method guards, pipes, interceptors, filters and request-scoped providers run as
on any controller. Admission enforces POST, exact origin, JSON content type,
body size/depth/node limits, prototype-pollution keys, host identity, CSRF, rate
limits and host authorization. Actions support versions, timeouts with
`AbortSignal`, serial dispatch, opt-in idempotency keys with replay and conflict
detection, Zod-compatible input/output schemas, JSON-safe output enforcement,
redirect/notification results and a typed error envelope with request ids and
production redaction. `@nestvexa/actions/codegen` (and the
`nestvexa-actions-codegen` CLI) uses the TypeScript compiler API to emit a
deterministic typed client for the browser-safe `@nestvexa/actions/client`.
