# Forms and auth starter (illustrative)

A NestJS + Nestvexa example for [`@nestvexa/forms`](../../packages/forms/README.md):

- **Register** (`/register`): class-validator DTO with a cross-field password
  confirmation, no-JS form with CSRF, `303` redirects, read-once errors and old
  input (never passwords), and a single-use submission token so a double submit
  creates one account.
- **Sign in / sign out** (`/login`, `POST /logout`): a custom adapter for
  presence checks plus a host-owned policy.
- **Profile** (`/profile`): one template that is a Live component with
  JavaScript (Zod adapter, blur validation, async email uniqueness, summary,
  focus on the first invalid field) and a plain `POST /profile` form without it.
  Saves are version-checked, so a stale tab cannot overwrite newer changes.

## Run

```sh
pnpm install
pnpm build
pnpm --filter @nestvexa/example-auth-forms start   # http://127.0.0.1:3104
```

`PORT` overrides the port. Browser tests: `tests/browser/forms.spec.ts`.

## The auth policy (host-owned)

`src/auth.ts` demonstrates careful defaults:

- `crypto.scrypt` (N=2^14, r=8, p=1) with a 16-byte per-user salt; comparison
  with `timingSafeEqual`; unknown accounts still derive a dummy hash;
- one generic message for every failed sign-in;
- throttling: 5 failures per account and 30 per client address in 15 minutes;
- session regeneration and CSRF token rotation on sign-in and registration
  (session fixation protection), regeneration on sign-out;
- CSRF on every POST and `Origin` checks as defense in depth; `httpOnly`,
  `SameSite=Lax` cookies; `Cache-Control: no-store` and a strict CSP on pages.

## Not a production identity provider

Accounts, sessions, throttling and submission tokens live in process memory and
disappear on restart. There is no email verification, password reset, MFA,
breached-password screening, account lockout notification, audit logging or
distributed rate limiting, and cookies are not `Secure` because the demo runs
over plain HTTP on localhost. Use a maintained identity solution or implement
those controls before handling real accounts.
