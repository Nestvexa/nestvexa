# CORS posture

Nestvexa registers no CORS handling of its own. No package calls
`app.enableCors()`, installs a CORS middleware or sets any
`Access-Control-Allow-*` header. Cross-origin access is therefore whatever the
host configures, and the default is none.

## Defaults

- **Preflights get no CORS headers.** An `OPTIONS` preflight from another origin
  to a Live action route (`/_nestvexa/live/...`), a server action
  route (`/_nestvexa/actions/...`) or an upload route
  (`/_nestvexa/uploads/files`, `/_nestvexa/uploads/sessions`) receives no
  `Access-Control-Allow-Origin`, `-Credentials`, `-Methods` or `-Headers`. The
  browser does not send the real request.
- **Cross-origin writes are refused before any handler runs.** Every
  state-changing Live, action and upload route checks the `Origin` header
  against the exact configured origin (scheme, host and port) and requires a
  session-bound CSRF token. A request from another origin, from `null`, from a
  look-alike host (`http://app.example.test.evil.example`), from the same host
  over another scheme or port, or with no `Origin` at all gets `403`. No
  component action, server action, upload authorization or storage write runs,
  and the response carries no CORS headers.
- **The origin check does not depend on CORS.** If a host turns on permissive
  credentialed CORS (for example `enableCors({ origin: true, credentials: true })`,
  which reflects any origin), the browser can send the request, but the
  exact-origin check still refuses it, even with a valid stolen CSRF token.
  Treat that CORS setting as a misconfiguration all the same: it exposes the
  host's own routes.

## Host guidance

- Leave CORS off for applications served from one origin. Nestvexa's browser
  clients (Live, server actions, uploads, realtime) call same-origin endpoints.
- If another origin must call your own API, enable CORS only for those routes
  and an explicit origin allowlist. Never reflect `Origin` with
  `credentials: true`.
- Configure the Live, actions and uploads `origin` options with the exact
  public origin users load. Behind a proxy, set it from configuration, never
  from request headers.
- Realtime WebSocket upgrades check the configured `origin` too; SSE and
  polling read channels with signed tokens and send no CORS headers.

## Evidence

[`tests/cors-posture.test.ts`](../../tests/cors-posture.test.ts) runs on
Express and Fastify. It checks preflights from hostile origins on every Live,
action and upload route, credentialed cross-origin writes with valid CSRF
tokens (six origin variants, including no `Origin`), the same-origin control
requests, and a host with permissive reflected credentialed CORS. The test
counts handler and policy invocations to prove nothing ran for refused
requests.
