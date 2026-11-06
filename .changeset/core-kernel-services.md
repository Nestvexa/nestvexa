---
'@nestvexa/core': minor
'@nestvexa/live': patch
'nestvexa': minor
---

Core kernel services: `RequestContextFactory` (correlation ID, CSP nonce,
tenant/session/principal, public subset), `SecurityPolicyRegistry` (CSRF,
origin, snapshot, action authorization, upload quotas with fail-closed
evaluation), `DiagnosticsRegistry` (typed events, metrics and spans with a
Live instrumentation adapter), `NestvexaExceptionFilter` (error envelope with
`correlationId` and `x-request-id`, redacted server-error logging), redaction
helpers and the `NestvexaExtension` hook API. `NestvexaModule.forRoot` accepts
a third kernel registration argument, routes Live spans to diagnostics by
default and records Live's policies in the security registry. The Live error
schema documents the optional `correlationId`.
