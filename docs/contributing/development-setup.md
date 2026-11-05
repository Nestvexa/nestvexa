# Development setup

## Prerequisites

| Tool     | Version                                                  | Why                                                       |
| -------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Node.js  | 22.13+ or 24 (both LTS; CI runs 22 and 24)               | `engines` of every package                                |
| pnpm     | 10.26.1 exactly (`packageManager` field; Corepack works) | Workspace and lockfile format                             |
| Git      | any recent                                               | Conventional commits, Changesets                          |
| Browsers | `pnpm exec playwright install chromium firefox webkit`   | Browser tests only                                        |
| Docker   | optional                                                 | `pnpm test:services` (Redis, S3-compatible store, ClamAV) |

## First build

```sh
pnpm install --frozen-lockfile
pnpm build              # every package in dependency order (pnpm -r --sort build)
pnpm lint               # ESLint + scripts/boundaries.mjs
pnpm typecheck          # build + strict compile of tests and configs
pnpm test               # full Vitest run
```

`pnpm install` respects `minimumReleaseAge: 1440` from `pnpm-workspace.yaml`: a
dependency version published less than a day ago will not resolve. Pick an older
patch rather than disabling the setting.

## Working on one package

```sh
pnpm --filter @nestvexa/live... build              # the package and everything it depends on
pnpm exec vitest run tests/live.test.ts            # only the files you touch
pnpm exec tsc -p tsconfig.tests.json --noEmit      # tests compile against the new types
pnpm exec prettier --write <changed files>
```

Tests live in the root `tests/` directory and import the built `dist` output through
package names, so rebuild after changing a package. New test files must be added to
the right group script in the root `package.json` (`test:unit`, `test:integration`,
`test:security`); see the [test matrix](test-matrix.md).

## Running an example

```sh
pnpm --filter @nestvexa/example-starter-live start
PORT=3400 pnpm --filter @nestvexa/example-starter-live start   # another port (POSIX shells)
```

Examples bind `127.0.0.1` and read `PORT`. Default ports are listed in
[ports](ports.md). In PowerShell set the variable first: `$env:PORT = '3400'`.

## Docs

```sh
pnpm build && pnpm docs:build      # checks + static site in artifacts/docs
node apps/docs/src/build.mjs --check-only   # checks only, no output
```

See the [site README](../../apps/docs/README.md) for the checks and how to add pages.

## Windows notes

- Every gate runs on Windows in CI (`windows-latest`, Node 22 and 24).
- Use Git Bash or PowerShell. `pnpm test:pack` should run from PowerShell; Git Bash
  path conversion can break `npm pack` arguments.
- Vitest uses one worker on Windows hosts (`vitest.config.ts`) to avoid file-lock
  flakiness; the suite is slower there.
- Line endings are LF (`.prettierrc` `endOfLine: lf`). Set `core.autocrlf=false` or
  `input` so Prettier checks do not fail on checkout.
- Long worktree paths can hit `MAX_PATH`; enable long paths (`git config core.longpaths
true`) if a deep `node_modules` path fails.

## Coding standards

- TypeScript strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
  No `any`, no non-null assertions, no `eslint-disable`, no `it.skip`/`it.only`.
- ESM only. Packages must not use top-level `await` (CommonJS hosts load them through
  `require(esm)`).
- Keep `@nestvexa/core` and `@nestvexa/views` free of renderer and browser imports, and
  browser packages free of `@nestjs/*`. `pnpm lint` enforces this.
- Optional integrations are optional peers. A new dependency must be pinned to an
  exact, published version and justified in the pull request.
