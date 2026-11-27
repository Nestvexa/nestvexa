---
'@nestvexa/core': minor
'nestvexa': minor
---

Bound slow clients (slowloris, trickled request heads and bodies). The new
`boundHttpServer(server, { headersTimeoutMs, requestTimeoutMs })` in
`@nestvexa/core` enforces per-connection timers on a Node HTTP/1.1 server and
answers a late client with `408` before closing it; upgraded connections and
streaming responses are unaffected. `configureNestvexa(app, { http })` applies
it to `app.getHttpServer()` by default on Express and Fastify (head 30 s, body
300 s). Fastify otherwise disables Node's request timeout. Pass `http: false`
to opt out.
