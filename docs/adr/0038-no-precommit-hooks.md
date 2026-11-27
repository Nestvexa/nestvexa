# 0038 — No precommit hooks; CI enforces formatting, linting and policy

Status: accepted (2026-11-27). Closes the open "precommit hooks" clause of spec 0.5
(PHASE-009) with an explicit decision instead of silence.

## Context

Spec 0.5 lists "precommit hooks" next to ESLint, Prettier, tests and CI. The
repository has never installed one: there is no husky, lefthook, simple-git-hooks or
`.githooks` configuration. Everything a hook would check is already a blocking CI
step on both Ubuntu and Windows (`.github/workflows/ci.yml`): `pnpm format:check`,
`pnpm typecheck`, `pnpm lint` (ESLint plus the [boundary checks](../../scripts/boundaries.mjs)),
the test groups, and the `pr-policy` job that requires a changeset for published
package changes. The release workflow repeats the same checks.

Most contributors, and every maintainer so far, work on Windows. When this ADR was
written, on the maintainer's Windows 11 machine (under load, with little free
memory), `pnpm exec eslint` on three staged files took 85 seconds and
`pnpm exec prettier --check` on one file 17 seconds, almost all of it process
start-up and configuration loading. Faster machines pay less, but a hook pays that
start-up cost on every commit.
Git hooks run through Git for Windows' bundled shell, which behaves differently from
PowerShell, cmd and the IDE terminals contributors actually use; a hook that fails in
one of them blocks the commit with an unfamiliar error. Hook installers also need a
`prepare`/`postinstall` script, and [ADR 0028](0028-workspace-and-build-tooling.md)
keeps install scripts restricted (`onlyBuiltDependencies` allows `esbuild` only).

## Decision

- **No precommit or prepush hook is installed or recommended by default.** CI is the
  single enforcement point; a green CI run on both operating systems is required to
  merge.
- **Contributors run the fast checks themselves before pushing**, as
  [CONTRIBUTING](../../CONTRIBUTING.md) says: `pnpm exec prettier --write <files>`
  (or `pnpm format`), `pnpm lint` and the tests they touched.
- **A personal hook stays possible.** Anyone who wants one can add
  `.git/hooks/pre-commit` locally (for example running
  `pnpm exec prettier --check` on staged files). It is not committed and must not be
  required by any script.

## Consequences

- No new dev dependencies, no install script and no per-commit latency, especially on
  Windows.
- A formatting or lint slip is caught minutes later by CI rather than at commit time.
  `pnpm format` fixes formatting in one command, and lint failures name the file and
  rule.
- Work-in-progress commits on a branch are never blocked, which keeps small, logical
  commits cheap.

## Alternatives rejected

- **simple-git-hooks + lint-staged (pinned), Prettier and ESLint on staged files.**
  The smallest viable hook. It still needs an install script to register the hook,
  adds two dev dependencies, and pays the start-up cost above on every commit. It
  would duplicate CI rather than add a check CI lacks.
- **husky.** The same trade-off with a larger configuration surface.
- **lefthook.** Ships a native binary per platform through an install script, which
  conflicts with the restricted `onlyBuiltDependencies` policy.

Revisit this decision if CI stops running `format:check` and `lint` on every pull
request, or if contributors ask for an opt-in hook; an opt-in script that installs a
hook on request would then be preferred over an automatic one.
