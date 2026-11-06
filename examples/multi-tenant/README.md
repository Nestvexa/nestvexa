# Multi-tenant workspaces

A Nest (Express) application with two seeded workspaces (tenants), host-owned
sign-in and three roles, showing how Nestvexa Live components stay inside one
tenant and one account.

| Who                   | Can                                                                     |
| --------------------- | ----------------------------------------------------------------------- |
| Guest (signed out)    | The workspace directory and each workspace's public page (`/t/:tenant`) |
| Member of a workspace | Its Live project board: create, rename, toggle status                   |
| Admin of a workspace  | Everything a member can, plus delete (with confirmation)                |

Seeded accounts (public demonstration password `demo-password-2026`):
`ada@acme.test` (Acme admin), `max@acme.test` (Acme member), `gus@globex.test`
(Globex admin), `liz@globex.test` (Globex member) and `sam@consult.test`
(member of both).

## Run

```sh
pnpm install
pnpm --filter @nestvexa/example-multi-tenant... build
pnpm --filter @nestvexa/example-multi-tenant start   # http://127.0.0.1:3119
```

`PORT` overrides the port. The root Playwright suite starts this example on
port **3119** and runs [`tests/browser/multi-tenant.spec.ts`](../../tests/browser/multi-tenant.spec.ts)
in Chromium, Firefox and WebKit (health URL `/api/health`).

## How isolation works

- **Tenant from the server, never the browser.** `/t/:tenant/projects` is
  protected by `TenantGuard`, a normal Nest guard: guests get `401` (the page
  filter turns it into a redirect to `/login`), accounts without a membership
  get `403` with a generic page that names no tenant data. The page records the
  verified tenant in the server-side session; Live components re-read it and
  re-check the membership on every request, and every repository call takes
  the tenant and filters by it.
- **Identity binding includes account, tenant and role.** The Live identity is
  `user:<id>:tenant:<slug>:role:<role>:session:<sid>`. Snapshots are stored per
  binding, so a snapshot rendered for Max is unavailable to Liz, and Sam's Acme
  snapshot stops working once he opens Globex (`410 INVALID_SNAPSHOT`). A role
  change or sign-in/out invalidates earlier snapshots the same way.
- **Role policy before component code.** `authorize` reads the role from the
  binding: guests can call nothing, members get the board/row actions, and
  only admins may call `tenant-project.remove`; a forged request from a member
  is refused with `403 ACTION_FORBIDDEN`. The component checks the role again
  (defense in depth).
- **Native REST.** `GET /api/t/:tenant/projects` uses the same guard and returns
  JSON; `GET /api/health` is an ordinary Nest route.
- **Per-row actions use child components.** Each project row is a nested Live
  component whose `projectId`, `name` and `status` are read-only props set by
  the board, so a row can only act on its own project, inside the active
  tenant.

The browser spec proves the negative cases: cross-tenant pages and API calls
return `403` without the other tenant's project names or Live snapshots, a
snapshot replayed from another account or tenant is refused and creates
nothing, a member's forged delete is refused, a wrong CSRF token is refused,
and guests are redirected away from member pages. It also runs axe on the
public, sign-in, member and forbidden pages.

## Security notes

- Sign-in uses scrypt (per-account salt, constant-time comparison, a dummy
  derivation for unknown emails) and one generic failure message. The session
  is regenerated and the CSRF token rotated on sign-in and sign-out. Forms are
  validated by `@nestvexa/forms` (`submitForm`) with CSRF and origin checks.
- Accounts, memberships, projects and sessions live in process memory and the
  session secret is random per start. Production needs a real identity
  provider (MFA, password reset, breach screening), a persistent session
  store, a stable secret, HTTPS-only cookies, audit logging and distributed
  throttling. There is no sign-in throttling in this example.
- The active tenant is per session: opening a second workspace in another tab
  invalidates the first tab's Live components (they ask for a reload). A host
  that needs simultaneous tabs can mount components with a server-set,
  read-only tenant state and re-check membership on every action instead.

## Known gaps

No invitation or role-management UI, no subdomain-based tenant resolution, no
database row-level security and no realtime fan-out per tenant (see
[`examples/realtime-dashboard`](../realtime-dashboard/README.md) for authorized
channels).
