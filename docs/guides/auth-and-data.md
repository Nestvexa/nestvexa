# Databases, authentication and multi-tenancy

Nestvexa does not ship an ORM, an authentication framework or a tenancy
model. Pages, Live components, Inertia pages, server actions, uploads and
realtime all run inside ordinary Nest modules, so the libraries a Nest
application already uses keep working, and the host decides who the user is.
This guide shows the patterns and points at runnable, tested examples.

## Databases: Prisma, TypeORM, Drizzle

Inject your data layer like any Nest provider. Live components and action
groups are Nest-managed, so constructor injection works there too:

```ts
@LiveComponent({ name: 'note-board', view: 'note-board' })
export class NoteBoard {
  constructor(@Inject(NOTES_STORE) private readonly store: NotesStore) {}
  @State({ writable: true, validate: isShortText }) draft = '';
  @Computed({ async: true }) async notes() {
    return this.store.list(20);
  }
  @Action() async add() {
    await this.store.add({ author: authorOf(this.request), body: this.draft });
  }
}
```

Use `@Computed({ async: true })` for reads and async actions for writes. Take
ownership fields (author, tenant, user id) from the server-side identity, never
from component state or action input.

| Example                                              | Stack                                               |
| ---------------------------------------------------- | --------------------------------------------------- |
| [`examples/orm-prisma`](../../examples/orm-prisma)   | Prisma 7 + libSQL driver adapter, `prisma generate` |
| [`examples/orm-typeorm`](../../examples/orm-typeorm) | TypeORM 1 + sql.js (WebAssembly SQLite)             |
| [`examples/orm-drizzle`](../../examples/orm-drizzle) | Drizzle ORM + libSQL, drizzle-kit migrations        |

The three share byte-identical application code (`src/app.ts`, `src/notes.ts`,
views); only `src/database.ts` differs. `tests/orm-examples.test.ts` boots each
against a fresh SQLite file and drives reads and writes through the MVC page,
the Live component and a server action, plus negative cases, and checks that no
Nestvexa package depends on an ORM or a database driver.

## Authentication: Passport, sessions and JWT

Use `@nestjs/passport`. Nestvexa only needs a function that maps a request to
an identity; derive it from whatever Passport put on the request:

```ts
// Browser sessions: express-session + passport.session()
app.use(session({ cookie: { httpOnly: true, sameSite: 'lax', secure } }));
app.use(passport.session());

NestvexaModule.forRoot(config, {
  components: [AccountPanel],
  useFactory: () => ({
    origin,
    resolveIdentity: (request) => ({
      binding: request.user
        ? `user:${request.user.id}:v${request.user.authVersion}:session:${request.sessionID}`
        : `guest:session:${request.sessionID}`,
      csrfToken: csrfToken(request), // @nestvexa/forms
    }),
    authorize: (identity, component, action) =>
      identity.binding.startsWith('user:') && allowed(component, action),
  }),
});
```

- Call `req.logIn(user)` (Passport 0.7 regenerates the session id) and
  `rotateCsrfToken(request)` after a successful sign-in; `req.logOut()` on
  sign-out. Classic forms go through `submitForm` or `verifyCsrf` from
  `@nestvexa/forms`.
- Put an auth version (or password-changed timestamp) in the session principal
  and in JWT claims, and check it in `deserializeUser` and the JWT strategy, so
  a password reset revokes every session and token.
- Bearer APIs use `AuthGuard('jwt')` with explicit `algorithms`, `issuer` and
  `audience`. They set no cookies, so they need no CSRF; never let a session
  cookie authenticate them. Server actions for bearer clients can disable CSRF
  (`csrf: { required: false }`) only when cookies are not accepted.
- Hash passwords with a maintained argon2id or bcrypt library; store reset and
  verification tokens as digests, single use, short lived; answer identically
  for unknown emails; do not consume tokens on GET.

[`examples/auth-passport`](../../examples/auth-passport) is an optional,
illustrative starter with all of the above (passport-local, sessions, JWT,
argon2, verification and reset mail through `@nestvexa/mail`, role and
verified-email guards, a Live account panel). `tests/auth-passport.test.ts`
covers every flow and its negative cases. Its README lists what a production
identity setup still needs; an OIDC provider is the recommended path.

## One user context everywhere

Write one module that resolves the request context from the session and
derive each transport's identity from it, as
[`examples/multi-tenant/src/context.ts`](../../examples/multi-tenant/src/context.ts)
does:

| Transport      | Identity it needs                  | Pattern                                               |
| -------------- | ---------------------------------- | ----------------------------------------------------- |
| MVC / REST     | Nest guard on the route            | guard re-checks membership before the handler         |
| Live           | `{ binding, csrfToken }`           | binding = user + tenant + role + session              |
| Inertia        | `share(request)`                   | display data from the same context, no ids or secrets |
| Server actions | `{ subject, tenant, csrfToken }`   | handlers scope by `context.identity.tenant`           |
| Uploads        | `{ binding, csrfToken, tenant }`   | tokens are bound to the binding                       |
| Realtime       | `{ binding }` + `authorizeChannel` | server-chosen channel names, re-checked on use        |
| Islands        | props rendered by the page         | signed props prove origin only; authorize again       |

Every policy runs on the server for every request: Live `authorize`, action
`authorize` and guards, upload `authorize`, realtime `authorizeChannel` (at
sign, connect and delivery). Because the binding names the user, tenant, role
and session, a snapshot, upload token or realtime token issued for one of them
is refused for any other.

## Multi-tenancy

- Resolve the tenant on the server: a guarded route (`/t/:tenant/...`) that
  verifies membership, or a verified host/subdomain mapping. Remember the
  selected tenant server-side (session) and re-verify it on every request.
- Never accept a tenant id from the body, query, headers or Live state. Actions
  that take no input refuse input; repositories take the tenant as a parameter
  and filter every query by it.
- Cache keys must include the tenant (`@nestvexa/cache` private scopes hash the
  binding and tenant) and run after the authorization guard; invalidate per
  tenant tag on writes.
- Test isolation per transport. `tests/multi-tenant-isolation.test.ts` covers
  MVC/REST, Live, Inertia, actions, islands, uploads, realtime and the cache
  for cross-tenant and cross-user access.
