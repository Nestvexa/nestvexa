# Passport auth starter (illustrative)

An optional starter that shows how a Nestvexa application uses the standard
Nest authentication stack instead of a homegrown one:

| Concern              | Library (pinned)                                                     |
| -------------------- | -------------------------------------------------------------------- |
| Credentials          | `passport-local` 1.0.0 through `@nestjs/passport` 12.0.1             |
| Browser sessions     | `express-session` 1.19.0 + `PassportSerializer` (`passport` 0.7.0)   |
| Bearer API           | `passport-jwt` 4.0.1 + `@nestjs/jwt` 12.0.4 (HS256, issuer/audience) |
| Password hashing     | `argon2` 0.45.2 (argon2id, m=19 MiB, t=2, p=1)                       |
| CSRF, forms, flash   | `@nestvexa/forms`                                                    |
| Verification / reset | `@nestvexa/mail` templates (console transport, memory in tests)      |

It is **illustrative**: accounts, sessions and tokens live in process memory.
See [Production identity](#production-identity) before reusing any of it.

## Run

```sh
pnpm install
pnpm --filter @nestvexa/example-auth-passport... build
pnpm --filter @nestvexa/example-auth-passport start   # http://127.0.0.1:4023
```

Seeded accounts use the public demonstration password `demo-password-2026`:
`ada@example.test` (admin) and `max@example.test` (member). Mail goes to the
console, so verification and reset links are printed in the terminal.

Environment: `PORT`, `PUBLIC_ORIGIN` (exact origin used in mailed links and
Origin checks; an `https:` origin turns on `Secure` `__Host-` cookies),
`TRUST_PROXY=1` (behind one TLS-terminating proxy), `SESSION_SECRET` and
`JWT_SECRET` (at least 32 characters; random per start when unset).

## Flows

- **Sign in** (`POST /login`): `@nestvexa/forms` checks CSRF, Origin and the
  input; the registered `passport-local` strategy checks the credentials
  (custom callback, so failures become one generic form error); `req.logIn`
  (Passport 0.7) regenerates the session id, then the CSRF token is rotated.
- **Sign out** (`POST /logout`, CSRF): `req.logOut` clears the login and
  regenerates the session.
- **Register** (`POST /register`): unverified member, verification email,
  signed in. A taken email gets the same generic error as other failures.
- **Verify email**: the mailed link opens `GET /verify-email?token=…`, which
  only shows a confirmation form (link scanners do not verify accounts);
  `POST /verify-email` (CSRF) consumes the token. Resend revokes older links.
- **Reset password**: `POST /forgot-password` answers identically whether or
  not the account exists; the link opens a form; `POST /reset-password` (CSRF)
  consumes the token, sets the new argon2id hash and bumps the account's auth
  version, which signs out every existing session and revokes every JWT.
  Requesting a new link revokes the previous one; links expire after 30
  minutes. Reset and verification pages send `Referrer-Policy: no-referrer`.
- **Tokens**: 256-bit values from `crypto.randomBytes`, stored only as SHA-256
  digests, single use, expiring (24 hours for verification).
- **Bearer API**: `POST /api/token` (`AuthGuard('local')`, no session) returns a
  15-minute HS256 JWT bound to the auth version; `GET /api/me` uses
  `AuthGuard('jwt')`; `GET /api/admin/stats` adds `RolesGuard`. Session cookies
  do not authenticate the API and the API sets no cookies, so it needs no CSRF.

## Authorization

- `SignedInGuard` (pages need a session; guests are redirected to `/login`),
  `VerifiedGuard` (`/reports` needs a confirmed email), `RolesGuard` with
  `@Roles(['admin'])` (`/admin`, `/api/admin/stats`), `CsrfGuard` for plain
  forms. Failures render a generic 403 page.
- The Live `account-panel` never stores the user in component state: every
  render and action re-reads `request.user` from the Passport session. The Live
  identity binds snapshots to the account, its auth version and the session id,
  and the Live policy allows only signed-in users to call the panel's actions.

## Production identity

This starter demonstrates wiring, not a complete identity provider. Before
handling real accounts add: a persistent session store and user database, a
stable secret per environment with rotation, HTTPS everywhere (set
`PUBLIC_ORIGIN=https://…`), sign-in and reset throttling (for example
`@nestjs/throttler`) and account lockout notification, breached-password
screening, MFA, audit logging, email deliverability (SPF/DKIM) and a
maintained mail transport, refresh-token handling or short JWT lifetimes with
revocation lists, and an external review. A hosted or self-hosted OIDC
provider (with `passport-openidconnect` or `openid-client`) replaces most of
this code and is the recommended production path.

Passport keeps strategies in a process-wide registry, so run one application
instance per process (the tests start a second instance only last).

## Tests

[`tests/auth-passport.test.ts`](../../tests/auth-passport.test.ts) boots the
starter in-process on port 4023 (and 4024 for the HTTPS-cookie check) with
`MemoryMailTransport` and a controllable clock. It covers wrong and unknown
credentials, missing CSRF and foreign Origin, session regeneration on sign-in
and sign-out (the old session id is not signed in), cookie attributes behind
HTTPS, guest/member/admin guards, the Live panel (rename, replay from another
account, wrong CSRF header, dead snapshot after sign-out), registration,
verification (single use, revoked on resend, expiry), password reset (no
enumeration, expired, revoked, mismatched, reused token, missing CSRF, sessions
and JWTs revoked after a reset) and the JWT API (tampered, unsigned
`alg: none`, wrong key, expired, wrong issuer/audience, stale auth version,
unknown subject, role checks).

```sh
pnpm --filter @nestvexa/example-auth-passport... build
pnpm exec vitest run tests/auth-passport.test.ts
```
