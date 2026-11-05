# Security guide for application developers

Nestvexa enforces a fixed set of transport checks on the routes it generates:
exact `Origin`, a session-bound CSRF token, identity-bound state, writable-field
allowlists, revision locks, size limits and escaping. Everything that depends on
who your users are and what they may do stays in your application. This guide
lists what you must supply at each boundary. Background:
[threat model](threat-model.md), [host hardening](hardening.md),
[ASVS traceability](asvs-traceability.md) and the
[vulnerability reporting policy](../../SECURITY.md).

> **Known gap:** no independent security review has been performed, and the
> full Section 17 attack corpus is incomplete (ledger SEC rows are Pending,
> QA-073 InProgress). Passing the automated security suites is evidence for the
> cases they test, not a guarantee.

## Trust boundaries at a glance

| Boundary                 | Nestvexa enforces                                                                                | You supply                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Browser → Live routes    | Origin, CSRF header, rate limit, snapshot ownership, revision, writable allowlist                | `resolveIdentity`, `authorize`, guards, resource-level checks   |
| Browser → server actions | POST + JSON only, Origin, CSRF, declared input size, identity, `authorize`                       | Identity policy, pipes/DTOs, business authorization             |
| Browser → uploads        | Type allowlist, magic bytes, sizes, quotas, single-use identity-bound tokens                     | Purposes, `authorize`, ownership on download, a malware scanner |
| Browser → realtime       | Signed identity-bound tokens, per-channel re-authorization, connection caps                      | `authorizeChannel`, stable secrets, revocation on logout        |
| Inertia pages            | Protocol headers, redirect target allowlist, version conflicts                                   | CSRF guard (`XSRF-TOKEN`), authentication, props selection      |
| Server state → HTML      | Escaping by default; client rejects scripts, inline handlers and executable URLs before morphing | Templates and helpers (trusted code), `SafeHtml` use, CSP       |

## Identity and authorization

Every Live, actions, uploads and realtime registration takes a `resolveIdentity`
callback. Derive it from your authenticated session on every request and never
from the request body, query string or a client header you do not control:

```ts
resolveIdentity(request) {
  const session = authenticatedSession(request); // your auth layer
  if (!session) throw new UnauthorizedException();
  return {
    // Unambiguous encoding of session, principal and tenant.
    binding: JSON.stringify([session.id, session.userId, session.tenantId]),
    csrfToken: session.csrfToken,
  };
},
authorize: (identity, component, action) =>
  policy.allows(identity, component, action), // deny by default
```

- The `binding` scopes state: a snapshot created for one binding returns `410`
  for any other. Include the tenant so switching tenants invalidates state.
- `authorize` must allow `$mount` and `$sync` explicitly and should deny unknown
  components and actions. It decides which actions a user may call, not which
  records: keep row-level checks in your services.
- Normal Nest `@UseGuards()` on a component class or on `@Action()` methods runs
  on the generated routes. Method guards do **not** run during `$sync`, so
  protect read access with class/global guards or `authorize`.

## CSRF and origin

- Set `origin` to the exact public origin. Cross-origin `POST`s are rejected with
  `403` before any component code runs.
- Live, actions and uploads expect the session token in `x-nestvexa-csrf`; the
  browser client sends it automatically from the rendered root.
- Inertia CSRF is host-owned: the official client sends the `XSRF-TOKEN` cookie
  value as `X-XSRF-TOKEN`; verify it with a guard as in the
  [Inertia guide](../guides/inertia.md).
- No-JavaScript forms use `csrfToken`/`verifyCsrf` from `@nestvexa/forms`; see the
  [forms guide](../guides/forms.md).

## Writable state is an allowlist, locked state is not authorization

Only `@State({ writable: true, validate })` fields accept browser updates; all
other state (including `@Locked()` fields) returns `422` on a write attempt.
Keep validators pure and bounded and keep business rules in actions. Locking a
field stops the browser from **changing** it, but anything rendered or returned
in state is visible to the user, and an action can still be called by anyone
`authorize` allows. Re-check permissions inside the action.

## Snapshots are references, not secrets

The browser holds an opaque random reference to server-side state in a
single-process `MemoryLiveStore`. Public state is rendered into HTML and action
responses. Never put secrets, tokens, other users' data or internal IDs you would
not show in `@State` or `@Computed` values. Signatures and opaque tokens do not
imply encryption. Send `Cache-Control: no-store` on pages carrying mount tokens,
and call `store.revoke(binding)` (with a store you construct and pass as the Live
`store` option) when a user logs out or loses access. See the
[Live protocol guide](../guides/live-protocol.md).

## XSS and safe HTML

- `{{value}}` escapes; `{{{value}}}` does not. Escaping does not validate URL
  schemes or make CSS safe: validate `href`/`src` values yourself.
- `SafeHtml.trusted(value)` marks HTML as trusted and does **not** sanitize. Never
  pass browser-provided text to it.
- Helpers and templates are trusted executable code. Never compile a template
  supplied by a user, and deploy views read-only outside upload directories.
- `nv:` directives are data-only: they name state fields and actions, never
  expressions. Event payloads and optimistic projections are untrusted input;
  validate them with `@ActionInput` pipes.
- Island props are plain bounded JSON, escaped into `data-nv-props`.

## Uploads

Declare one purpose per use with the narrowest `types`, `maxFileSize` and
`maxFiles`; keep `directory` outside every served folder; configure
`ClamdScanner` and `requireScan: true` where policy requires scanning (Nestvexa
detects no malware itself); and check ownership before `uploads.download`.
Downloads default to attachments with `nosniff`. Details: the
[uploads guide](../guides/uploads.md#7-threat-model-summary).

## Realtime tokens

Channel tokens are signed, not encrypted, and channel names are visible to the
browser, so do not encode secrets in them. `authorizeChannel` is re-run at
subscribe time, periodically and before delivery. SSE tokens travel in the query
string: keep them out of shared access logs. Call `realtime.revoke(binding)` on
logout and `closeChannel(channel)` on permission changes. Pushed `data` is public.

## Tenant isolation

Resolve the tenant on the server from the authenticated session, include it in
every identity binding (Live, uploads `tenant`, realtime), name realtime channels
per tenant and add the tenant to cache `vary` keys.

> **Known gap:** there is no shared server-side tenant resolution helper and no
> cross-transport tenant isolation test across Live, actions, Inertia, realtime
> and stores (DATA-017, DATA-018). Each transport takes its own identity resolver.

## CSP and response headers

The Live client and Alpine CSP build run under `script-src 'self'` without
`unsafe-eval`; add `connect-src 'self'` for realtime and use
`{{nvScripts nonce=cspNonce}}` for nonce policies. Nestvexa sets no CSP header
for you. See [CSP and security headers](../deployment/csp-and-headers.md).

## Logging and incident response

- Log through `createLogger()` or `redact()` from `@nestvexa/observability`, which
  strip passwords, tokens, cookies, sessions, CSRF values, snapshots and
  bindings. Live spans never carry state, identities or HTML.
- If a session or signing secret leaks: rotate the session secret, rotate
  realtime secrets (the first of `secrets` signs, the others still verify, so you
  can roll), and revoke affected bindings in the Live store and realtime. Pending
  upload tokens expire with `tokenTtlMs` (default 15 minutes) and are dropped on
  restart; `uploads.discard(request, token)` cancels one immediately.
- Apply dependency overrides in your own app too: for example the Multer override
  described in [host hardening](hardening.md) does not transfer from this
  repository's lockfile.
- Report vulnerabilities in Nestvexa privately as described in
  [SECURITY.md](../../SECURITY.md).
