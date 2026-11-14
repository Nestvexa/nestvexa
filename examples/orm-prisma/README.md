# Nestvexa with Prisma

A small Nest (Express) application that keeps notes in SQLite through
Prisma ORM 7.10.1 (`@prisma/client`, generator `prisma-client`) with the libSQL driver adapter (`@prisma/adapter-libsql` 7.10.1, `@libsql/client` 0.18.0). It shows that Nestvexa needs nothing from the ORM: an HBS page
(MVC), a Live component and a server action all read and write through one
ordinary Nest provider.

No Nestvexa package depends on an ORM or a database driver
(`tests/orm-examples.test.ts` checks every package manifest). The same
application exists for the other ORMs in [`orm-typeorm`](../orm-typeorm/README.md) and [`orm-drizzle`](../orm-drizzle/README.md); `src/app.ts`,
`src/notes.ts` and the views are byte-identical across the three, and only the
database module differs.

## Run

```sh
pnpm install
pnpm --filter @nestvexa/example-orm-prisma... build
pnpm --filter @nestvexa/example-orm-prisma start   # http://127.0.0.1:4020
```

`PORT` overrides the port and `DATABASE_FILE` the SQLite file (default
`data/notes.sqlite` in this directory, git-ignored). No database server is
needed.

`prisma generate` needs no database and no downloaded engine in Prisma 7;
the workspace lists `prisma` and `@prisma/engines` under
`ignoredBuiltDependencies`, so their install scripts never run. The build
works the same on Windows and Linux (`prisma generate && tsc`).

## What is where

- `src/notes.ts` (ORM-neutral): the `NotesStore` port, the `note-board` Live
  component (`@Computed({ async: true })` reads, an `add` action writes), the
  `notes` server-action group (`list`, `add`) and the MVC page controller.
- `src/app.ts` (ORM-neutral): `createApp({ port, databaseFile })` wires the
  database module, Live, server actions and sessions; `src/main.ts` listens.
- `prisma/schema.prisma`: the `Note` model. `prisma generate` runs in the
  example's `build` script and writes the typed client to
  `src/generated/prisma` (git-ignored, excluded from lint and formatting).
- `prisma/migrations/`: the committed migration SQL. On a new database file the
  example applies it at startup (demonstration only); deployed databases run
  `prisma migrate deploy`, which also records applied migrations.
- `prisma.config.ts`: Prisma CLI configuration (`DATABASE_URL` for migrate
  commands).
- `src/database.ts`: the Nest recipe, a `PrismaService extends PrismaClient`
  provider that connects on module init and disconnects on shutdown, and a
  `NotesStore` implementation on top of it.

## Security notes

- The note author is derived from the server-side session, never from the
  request body (a client `author` field is ignored).
- Live snapshots are bound to the session; server actions require the exact
  Origin and the session's CSRF token. Inputs are bounded (280 characters).
- Sessions use the in-memory store and a random secret per start. Production
  needs a persistent session store, a stable secret, `Secure` cookies, real
  authentication (see [`examples/auth-passport`](../auth-passport/README.md))
  and a real database with backups.

## Tests

[`tests/orm-examples.test.ts`](../../tests/orm-examples.test.ts) boots this
example in-process on port 4020 against a fresh SQLite file and drives
a Live write, a Live validation failure, an action write and read, the MVC
page, negative cases (wrong CSRF token, missing Origin, invalid input, a Live
snapshot replayed from another session) and persistence across a restart.

```sh
pnpm --filter "@nestvexa/example-orm-*..." build
pnpm exec vitest run tests/orm-examples.test.ts
```
