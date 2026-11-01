# @nestvexa/cli

The `nestvexa` command line: wire Nestvexa into an existing NestJS app, check its
configuration, add optional packages, generate components/pages/resources, inspect
routes and remove generated code safely.

## Install

```sh
npm install --save-dev @nestvexa/cli
npx nestvexa --help
```

Node 22.13+ or 24. The CLI depends on `typescript` for AST-based source edits.

## Commands

| Command                                              | What it does                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nestvexa init`                                      | Adds `nestvexa` + `express-session`, creates `views/` (layout, welcome, counter), `src/nestvexa/` (config, counter component, welcome controller at `/nestvexa`), and patches `app.module.ts` (imports/controllers) and `main.ts` (session + `configureNestvexa(app)` before `listen`). Existing routes are untouched. Idempotent. |
| `nestvexa doctor`                                    | Node/Nest versions, installation, duplicate browser runtimes, `{{nvScripts}}`, `configureNestvexa`, sessions, literal secrets (never printed). Exit 1 on failure.                                                                                                                                                                  |
| `nestvexa check`                                     | `doctor` plus a strict TypeScript compile of the project.                                                                                                                                                                                                                                                                          |
| `nestvexa add engine <hbs\|ejs\|pug\|nunjucks>`      | Adds the engine adapter dependency.                                                                                                                                                                                                                                                                                                |
| `nestvexa add <realtime\|redis\|cache\|inertia>`     | Adds the optional package and prints wiring steps.                                                                                                                                                                                                                                                                                 |
| `nestvexa make:component <Name>`                     | Live component class + view; registers and authorizes it when `nestvexa.config.ts` has the generated markers.                                                                                                                                                                                                                      |
| `nestvexa make:page <Name> [--renderer hbs]`         | Controller + view, registered in `app.module.ts`. Other renderers fail explicitly (exit 2) in this version.                                                                                                                                                                                                                        |
| `nestvexa make:layout <Name>` / `make:policy <Name>` | Layout view / deny-by-default guard.                                                                                                                                                                                                                                                                                               |
| `nestvexa make:resource <Name>`                      | In-memory service + Live CRUD table + view (no schema migration).                                                                                                                                                                                                                                                                  |
| `nestvexa inspect:routes\|components\|actions`       | Static source inspection with the TypeScript AST; no app code runs.                                                                                                                                                                                                                                                                |
| `nestvexa remove <feature>`                          | Deletes generated files of a feature (`init`, `component:<name>`, `page:<name>`, …) only if unchanged; modified files are kept and reported.                                                                                                                                                                                       |
| `nestvexa build`                                     | Runs the project `build` script.                                                                                                                                                                                                                                                                                                   |
| `nestvexa migrate`                                   | Reports/applies version migrations (none are required within 0.1 alpha).                                                                                                                                                                                                                                                           |

Options: `--dry-run`, `--force`, `--install`, `--yes` (accepted; the CLI never
prompts), `--json`, `--quiet`, `--verbose`, `--cwd <dir>`, `--help`, `--version`.
Unknown commands or options exit with code 2.

## Safety

- All edits of one command form a plan applied atomically: files are backed up and
  restored if any write fails.
- Paths are confined to the project root.
- Generated files are recorded with SHA-256 checksums in `.nestvexa/manifest.json`;
  `remove` never deletes a file you changed and never edits files you wrote.
- Existing generated files are not overwritten without `--force`.
- Source patches use the TypeScript compiler API, not regular expressions, and are
  skipped when the target code is already present.

## Limits

`init` wires `express-session` and supports Express hosts; Fastify hosts get an
explicit error with documentation pointers. The generated session/identity policy is
a guest starter and must be replaced for production. React/Vue/Svelte/i18n
generators and `make:action`/`make:island` require their adapter packages and are
not part of this version. `inspect:*` reads source statically and cannot see routes
registered dynamically.

## Testing

```sh
pnpm --filter @nestvexa/cli build && pnpm vitest run tests/cli.test.ts
```

The end-to-end test runs `init` and generators on a fresh CommonJS Nest app,
compiles it with `tsc`, boots it, renders `/nestvexa` and executes a Live action.

License: MIT.
