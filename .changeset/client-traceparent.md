---
'@nestvexa/client': minor
---

Add the `tracing` option: `true` sends a new sampled W3C `traceparent` with
each Live request (retries reuse it), a function supplies one from a browser
tracing SDK, and malformed values are never sent. `LiveDiagnostic` samples now
include the component name, `requestBytes`/`responseBytes` on the request
phase and the `traceId` when tracing is on.
