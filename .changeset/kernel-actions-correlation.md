---
'@nestvexa/actions': minor
---

Add the structural `requestContext` option: the action request ID (envelope,
`x-nestvexa-request-id`, spans and call logs) uses the kernel correlation ID from
`RequestContextFactory`.
