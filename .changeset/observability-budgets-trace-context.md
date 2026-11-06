---
'@nestvexa/observability': minor
'@nestvexa/actions': minor
'@nestvexa/uploads': minor
'@nestvexa/inertia': minor
'@nestvexa/live': patch
---

Add development-only render budget warnings (`renderBudgetInstrumentation`), W3C
trace context parsing and request-scoped propagation (`traceContextMiddleware`,
OpenTelemetry parenting through a structural API) and optional structural
`instrumentation` hooks for server actions (`nestvexa.action`), uploads
(`nestvexa.upload.receive`/`finalize`) and Inertia page responses
(`nestvexa.inertia.render`). Live render spans now report `nestvexa.state_bytes`.
