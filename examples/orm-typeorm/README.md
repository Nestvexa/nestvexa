# Nestvexa with TypeORM

A small Nest (Express) application that keeps notes in SQLite through
TypeORM 1.1.2 with the `sqljs` driver (`sql.js` 1.15.2: SQLite compiled to WebAssembly, no native module). It shows that Nestvexa needs nothing from the ORM: an HBS page
(MVC), a Live component and a server action all read and write through one
ordinary Nest provider.

No Nestvexa package depends on an ORM or a database driver
(`tests/orm-examples.test.ts` checks every package manifest). The same
application exists for the other ORMs in [`orm-prisma`](../orm-prisma/README.md) and [`orm-drizzle`](../orm-drizzle/README.md); `src/app.ts`,
`src/notes.ts` and the views are byte-identical across the three, and only the
database module differs.

## Run

```sh
pnpm install
pnpm --filter @nestvexa/example-orm-typeorm... build
pnpm --filter @nestvexa/example-orm-typeorm start   # http://127.0.0.1:4021
```

`PORT` overrides the port and `DATABASE_FILE` the SQLite file (default
`data/notes.sqlite` in this directory, git-ignored). No database server is
needed.

The build is plain `tsc`.

## What is where

- `src/notes.ts` (ORM-neutral): the `NotesStore` port, the `note-board` Live
  component (`@Computed({ async: true })` reads, an `add` action writes), the
  `notes` server-action group (`list`, `add`) and the MVC page controller.
- `src/app.ts` (ORM-neutral): `createApp({ port, databaseFile })` wires the
  database module, Live, server actions and sessions; `src/main.ts` listens.
- `src/note.entity.ts`: the `NoteEntity` (`@Entity`, `@Column`).
- `src/migrations/1794100000000-create-notes.ts`: a versioned migration;
  `migrationsRun: true` applies pending migrations at startup and
  `synchronize` stays off.
- `src/database.ts`: one `DataSource` provider (initialized before the app
  starts, destroyed on shutdown) and a `NotesStore` implementation on its
  repository. `location` + `autoSave` persist the in-memory sql.js database to
  the file after every write. `@nestjs/typeorm`'s `TypeOrmModule` works the same
  way if you prefer it; this example keeps the dependency list minimal.

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
example in-process on port 4021 against a fresh SQLite file and drives
a Live write, a Live validation failure, an action write and read, the MVC
page, negative cases (wrong CSRF token, missing Origin, invalid input, a Live
snapshot replayed from another session) and persistence across a restart.

```sh
pnpm --filter "@nestvexa/example-orm-*..." build
pnpm exec vitest run tests/orm-examples.test.ts
```
