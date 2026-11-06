# CLI reference

The `nestvexa` command line: wire Nestvexa into an existing NestJS app, check its
configuration, add optional packages, generate components, pages, forms, actions,
islands and tests, inspect routes, migrate between versions and remove generated
code safely.

## Install

```sh
npm install --save-dev @nestvexa/cli
npx nestvexa --help
```

Node 22.13+ or 24. The CLI depends on `typescript` for AST-based source edits.
It never prompts; every command is scriptable and supports `--dry-run`.

## Commands

| Command                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nestvexa init`                                                                  | Adds `nestvexa` and guest sessions (`express-session` on Express; `@fastify/cookie` + `@fastify/session` registered by `src/nestvexa/session.ts` on Fastify), creates `views/` (layout, welcome, counter), `src/nestvexa/` (config, counter component, welcome controller at `/nestvexa`), and patches `app.module.ts` (imports/controllers) and `main.ts` (sessions + `configureNestvexa(app)` before `listen`). Existing routes are untouched. Idempotent.                          |
| `nestvexa doctor [--production]`                                                 | Node/Nest/platform versions, installed Nestvexa packages and their **peer ranges**, version alignment, duplicate browser runtimes, `{{nvScripts}}`, **template engines**, `configureNestvexa`, sessions (express-session or @fastify/session), **CSRF/authorization flags and session cookie flags**, session/realtime **secret length**, `NESTVEXA_ORIGIN`, `REDIS_URL` (with `@nestvexa/realtime-redis`), **Vite manifests and SSR bundles**, **devtools guarded from production**. |
| `nestvexa check`                                                                 | `doctor` plus a strict TypeScript compile of the project.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nestvexa add engine <hbs\|ejs\|pug\|nunjucks>`                                  | Adds the adapter, `src/nestvexa/engines/<engine>.engine.ts`, `views/layouts/main.<ext>` and `await register<Engine>Engine(app)` in `main.ts` (via `registerViewEngine` from `nestvexa`: `app.engine()` on Express, extension dispatch of `reply.view` on Fastify). `.ejs`/`.pug`/`.njk` views render with the adapter next to the default HBS engine.                                                                                                                                 |
| `nestvexa add <react\|vue\|svelte>`                                              | An independent Inertia root per framework: pinned dependencies, `client/<fw>/` (browser entry, **SSR entry**, page registry, tsconfig), `vite.<fw>.config.ts`, `dev:<fw>`/`build:<fw>` (client + SSR builds)/`typecheck:<fw>` scripts plus a shared `build:client`, a `Welcome` page at `/<fw>`, and the entry in `src/nestvexa/inertia.config.ts`. Sets up `add inertia` on first use.                                                                                               |
| `nestvexa add inertia`                                                           | `@nestvexa/inertia` + `@nestvexa/vite`, `inertia.config.ts`, `InertiaModule.forRoot(inertiaOptions())` and `configureInertia(app)`.                                                                                                                                                                                                                                                                                                                                                   |
| `nestvexa add islands [react\|vue\|svelte]`                                      | `@nestvexa/islands`: server registry, client allowlist, `vite.islands.config.ts`, `build:islands`, static serving and the bundle script tag in `views/layout.hbs`.                                                                                                                                                                                                                                                                                                                    |
| `nestvexa add <forms\|actions\|realtime\|redis\|uploads\|i18n\|devtools\|cache>` | Dependencies plus generated configuration: realtime (signing secret from `REALTIME_SECRET`, deny-by-default channels, Live wiring), redis (realtime plus `@nestvexa/realtime-redis`: `redis.config.ts` switches the Live store and realtime broker to Redis when `REDIS_URL` is set), uploads (purpose allowlist, `configureUploads`), i18n (catalogs in `locales/`, HBS helpers), devtools (development error page), actions (policy config).                                        |
| `nestvexa make:component <Name> [--view hbs] [--module <dir>]`                   | Live component class + view; registers and authorizes it when `nestvexa.config.ts` has the generated markers. `--module billing` puts the class under `src/billing/components/`. Other views exit 2 (Live shares the umbrella HBS renderer).                                                                                                                                                                                                                                          |
| `nestvexa make:page <Name> [--renderer …]`                                       | `hbs` (default), `ejs`, `pug`, `nunjucks` (controller + view) or `react`, `vue`, `svelte` (controller with `@InertiaPage(name, { app })` + page component). Registers the controller; sets up the engine or root on first use.                                                                                                                                                                                                                                                        |
| `nestvexa make:layout <Name>` / `make:policy <Name>`                             | Layout view / deny-by-default guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `nestvexa make:form <Name>`                                                      | Live form validated by `@nestvexa/forms` with a Zod schema (per-field and submit validation, accessible errors); registered and authorized (`$mount`, `$sync`, `submit`).                                                                                                                                                                                                                                                                                                             |
| `nestvexa make:action <Name>`                                                    | `@ActionGroup` with a `greet` server action, appended to `actionGroups` and the deny-by-default `allowedActions` in `actions.config.ts`; `ActionsModule.register(actionsOptions)` is added once.                                                                                                                                                                                                                                                                                      |
| `nestvexa make:resource <Name> [--crud] [--orm memory]`                          | In-memory service, module, Live CRUD table + view (registered with its module in `liveImports`); `--crud` adds REST routes. Other ORMs exit 2.                                                                                                                                                                                                                                                                                                                                        |
| `nestvexa make:island <Name> --renderer <react\|vue\|svelte>`                    | Island component (`.tsx`, or `.vue`/`.svelte` with a wrapper), the server `IslandRegistry` entry and the client module allowlist entry; adds the framework plugin to the islands Vite config.                                                                                                                                                                                                                                                                                         |
| `nestvexa make:test <Name> [--kind …]`                                           | Detects the generated artifact (component, page, form, action) or writes an HTTP smoke test booting `AppModule`. Uses vitest unless the project uses jest.                                                                                                                                                                                                                                                                                                                            |
| `nestvexa templates` / `templates:eject <id>`                                    | List generator templates (version, override, outdated files) / copy one to `.nestvexa/templates/<id>` to customize it.                                                                                                                                                                                                                                                                                                                                                                |
| `nestvexa inspect:routes\|components\|actions`                                   | Static source inspection with the TypeScript AST; no app code runs.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `nestvexa remove <feature>`                                                      | Deletes generated files of a feature (`init`, `component:<name>`, `page:<name>`, …) only if unchanged; modified files are kept and reported.                                                                                                                                                                                                                                                                                                                                          |
| `nestvexa build`                                                                 | Runs the project `build` script (output goes to stderr with `--json`).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `nestvexa migrate [--revert <id>]`                                               | Applies pending versioned migrations atomically and records them; reverts the latest one from its backup.                                                                                                                                                                                                                                                                                                                                                                             |

Options: `--dry-run`, `--force`, `--install`, `--yes` (accepted; the CLI never
prompts), `--json`, `--quiet`, `--verbose`, `--cwd <dir>`, `--help`, `--version`.
Unknown commands, options and missing option values exit with code 2; command
failures exit 1. With `--json`, the last stdout line is
`{ ok, changes, messages, data }` or `{ ok: false, error, exitCode }`.
`--quiet` prints nothing on success; `--verbose` lists every planned change (by
default more than 20 are summarized).

## Pinned dependencies

`add` and the generators add first-party packages as `^<CLI version>` and every
third-party package at the exact version this repository builds and tests with
(React 19.3.1, Vue 3.5.44, Svelte 5.57.3, `@inertiajs/*` 3.10.0, Vite 8.3.5, the
Vite framework plugins, Zod 4.6.7, …; see `packages/cli/src/versions.ts`). A test
fails when an example moves to another version without the table. Existing
ranges in `package.json` are never changed.

## Frontend roots and islands

Each `add react|vue|svelte` root is isolated: its own Vite config, base
(`/build/<fw>/`), manifest (`dist/<fw>/client/.vite/manifest.json`), asset
version and dev server port (5173/5174/5175). In development the Inertia root view
points at that Vite dev server (`npm run dev:react` next to the Nest server); with
`NODE_ENV=production` the manifest is read at startup (missing builds fail fast)
and `configureInertia(app)` serves the built files. Each root also gets an SSR
entry (`client/<fw>/ssr.ts(x)`, sharing the page registry and title with the
browser entry); `build:<fw>` writes `dist/<fw>/ssr/ssr.mjs` next to the client
build, and in production `inertia.config.ts` renders pages in-process with it
(`moduleSsrRenderer`, fallback to the client-rendered document on a render
error; a missing bundle fails at startup). `NESTVEXA_ASSETS=build` uses the built
assets and SSR in development too (for end-to-end tests without Vite dev
servers). The server `tsconfig.json`
(and `tsconfig.build.json`) get `client` and `vite.*.config.ts` excluded when they
have no `include`; a tsconfig with comments is left untouched and an instruction is
printed.

## doctor

`nestvexa doctor --json` prints the checks as `data: [{ name, status, detail, hint? }]`
with `status` `pass`, `warn` or `fail`; the exit code is 1 when any check fails.
Values of `SESSION_SECRET`, `REALTIME_SECRET` and `REDIS_URL` are never printed — only whether
they are set and their length. `--production` (or `NODE_ENV=production`) turns
deployment gaps into failures: missing/short secrets, missing `NESTVEXA_ORIGIN`,
missing Vite manifests or SSR bundles and development tooling (`DevtoolsModule`,
`DevErrorFilter`) registered without a `NODE_ENV` guard.

## migrate

Migrations are versioned steps (`0001-…`) that inspect the project to decide
whether they apply, edit files with the TypeScript AST and run in one atomic
plan. Each applied step is recorded in `.nestvexa/manifest.json` (`migrations`)
with a backup in `.nestvexa/migrations/<id>.json`. `--dry-run` lists pending steps
and planned changes; `--revert <id>` restores the newest step's files and refuses
when they were edited since (unless `--force`).

| Step                                         | Change                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001-manifest-v2`                           | Manifest version 1 → 2 (template ids/versions and the migration log). A v1 manifest stays v1 until migrated.                                                                                                 |
| `0002-session-secret-required-in-production` | `main.ts` from the first alpha `init` fell back to a random session secret in production. Replaces exactly that expression with `sessionSecret()` (requires `SESSION_SECRET` ≥ 32 characters in production). |

## Templates

Generator output comes from versioned templates (`nestvexa templates`). Eject one
with `nestvexa templates:eject component.class`, edit
`.nestvexa/templates/component.class` (`NvPascalName`, `nv-kebab-name` and
`nvCamelName` are replaced by the generated name) and later generators use it. The
manifest records which template id (`custom:<id>` for overrides) and version
produced each file. Generated code compiles under `strict`,
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; the CLI does not run
your formatter — run it on the reported files.

## Safety

- All edits of one command form a plan applied atomically: files are backed up and
  restored if any write fails.
- Paths are confined to the project root; names allow letters, digits and hyphens.
- Generated files are recorded with SHA-256 checksums in `.nestvexa/manifest.json`;
  `remove` never deletes a file you changed and never edits files you wrote.
- Existing generated files are not overwritten without `--force`; re-running a
  generator with identical output is a no-op.
- Source patches use the TypeScript compiler API, not regular expressions, and are
  skipped when the target code is already present.

## Development error page

`nestvexa add devtools` registers `DevErrorFilter` from `@nestvexa/observability`
only when `NODE_ENV !== 'production'` (the filter also refuses to construct in
production). Server errors on HTML requests render the message, cause chain, the
failing **template `file:line`** with an excerpt (HBS, EJS, Pug, Nunjucks) and
**clickable editor links** (`vscode://file/…:line:column`; `cursor`, `idea` or
`file` via the `editor` option) for template and application stack frames. Only
files inside `viewsRoot` are read. JSON clients and HTTP exceptions keep Nest's
default responses.

## Express and Fastify

Every command works on Express and Fastify hosts (`@nestjs/platform-fastify` in
`package.json` selects Fastify). On Fastify, `init` adds `@fastify/cookie` and
`@fastify/session` (`src/nestvexa/session.ts`, `await configureSession(app)`
before `configureNestvexa`), generated identity policies read
`request.session.sessionId` instead of `request.sessionID`, engines dispatch by
view extension inside the `reply.view` decorator, and Inertia/islands static
files are served through Nest's Fastify middleware support.
`tests/cli-fastify.test.ts` proves this end to end.

## Reference app

[`examples/cli-generated`](../../examples/cli-generated/README.md) is produced by
`node scripts/generate-cli-example.mjs` from a bare Nest app using only CLI
commands (pages for every engine and frontend, form, action, island, CRUD
resource, realtime, uploads, i18n, migrate) plus one hand-written showcase page.
`tests/cli-example.test.ts` regenerates it and fails on any difference;
`tests/browser/cli-generated.spec.ts` drives it in a browser with axe.

## Limits

Live components keep the umbrella HBS renderer (`make:component --view`
accepts only `hbs`). `make:resource --orm` generates only the in-memory service.
The generated session/identity
policies are guest starters and must be replaced for production. `inspect:*`
reads source statically and cannot see routes registered dynamically.
`make:test` targets vitest (jest projects get `@jest/globals` imports, not
type-checked in this repository).

## Testing

```sh
pnpm --filter @nestvexa/cli... build
pnpm exec vitest run tests/cli.test.ts tests/cli-generators.test.ts tests/cli-fastify.test.ts tests/cli-inertia-ssr.test.ts tests/cli-example.test.ts tests/dev-errors.test.ts
```

`tests/cli.test.ts` runs `init` and generators on a fresh CommonJS Nest app,
compiles, boots it and executes a Live action. `tests/cli-generators.test.ts`
runs every `add` (idempotency and dry run) and generator on a strict ESM app,
type-checks all output with `tsc`, `vue-tsc` and `svelte-check`, runs the generated
unit tests, boots the app (EJS/Pug/Nunjucks pages, Inertia roots, actions, the dev
error page), checks doctor JSON/production failures and secret redaction,
templates, output modes, Windows paths, `build` and the migration framework.
`tests/cli-fastify.test.ts` does the same on a Fastify app (sessions, engines,
Inertia, islands, uploads, realtime and redis against a RESP test double).
`tests/cli-inertia-ssr.test.ts` builds the three generated roots with Vite and
checks production SSR.

Package: [@nestvexa/cli](../../packages/cli/README.md).
