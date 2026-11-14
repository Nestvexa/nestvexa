# Multi-tenant workspaces

A Nest (Express) application with two seeded workspaces (tenants), host-owned
sign-in and three roles, showing how every Nestvexa transport (pages, Live,
Inertia, server actions, islands, uploads, realtime and the cache) stays inside
one tenant and one account.

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

## One user context across transports

`src/context.ts` is the single place that turns a request into the signed-in
user and the active tenant. It reads only the server-side session and
re-checks the membership against the directory on every call; every transport
derives its identity from it:

| Transport       | Where                                           | Tenant comes from                                          |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| MVC pages, REST | `src/pages.ts`, `TenantGuard`                   | the guarded `/t/:tenant` route, membership verified        |
| Live            | `liveIdentity`, `authorizeLive`                 | the active tenant in the session (set by the page route)   |
| Inertia         | `GET /t/:tenant/report`, `sharedProps`          | the guarded route; shared props from the same context      |
| Server actions  | `actionIdentity`, `WorkspaceActions`            | `identity.tenant`, verified per call; input cannot name it |
| Islands         | `src/islands.ts` (signed props)                 | rendered for the page tenant; re-checked when sent back    |
| Uploads         | `uploadIdentity`, `POST /t/:tenant/attachments` | tokens are bound to the user, tenant and session           |
| Realtime        | `realtimeIdentity`, `authorizeChannel`          | one server-chosen channel per tenant, re-checked on use    |
| Cache           | `src/events.ts` (`@nestvexa/cache`)             | the tenant is part of the key; writes invalidate its tag   |

No endpoint accepts a tenant id from the body, query or headers: actions that
take no input refuse any input (`UNEXPECTED_INPUT`), a `tenant` field in action
input is ignored, and Live components hold no tenant state.

The island has no client bundle in this example: it renders its server
fallback (`N projects`) with signed props, which the `workspace/island-stats`
action verifies and then re-authorizes (a valid signature from another
tenant's page is refused). The Inertia report renders the protocol's root
document without a client bundle; Inertia clients receive JSON page objects.

[`tests/multi-tenant-isolation.test.ts`](../../tests/multi-tenant-isolation.test.ts)
boots the example in-process (port 4026) and proves cross-tenant and
cross-user isolation on each transport: MVC/REST, Live (replays across accounts
and tenants, tenant switches, forged state), Inertia, server actions (smuggled
tenant ids, no active tenant, another session's CSRF token), islands (foreign
and tampered signed props), uploads (tokens of another user or tenant, tenant
switch, guests), realtime (borrowed tokens, events reach only the tenant, a
switch revokes the old token) and the cache (per-tenant keys, guard before
cache, invalidation on writes).

## Known gaps

No invitation or role-management UI, no subdomain-based tenant resolution and
no database row-level security. Realtime uses the in-process broker and the
cache an in-process store; several replicas need a shared broker
(`@nestvexa/realtime-redis`) and shared cache invalidation. The island and the
Inertia page have no browser bundle here (see
[`examples/showcase`](../showcase/README.md) for bundled islands and Inertia).
