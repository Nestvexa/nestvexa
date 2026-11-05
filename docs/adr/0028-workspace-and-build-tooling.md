# 0028 — Workspace and build tooling without a task orchestrator

Status: accepted (2026-11-05). Records a decision in force since the first commit
that had not been written down (spec 3, ARCH-002).

## Context

Spec 3 asks for a pnpm workspace or an equally mature alternative, TypeScript project
references "where beneficial", a cached task graph only "if justified", Changesets
or equivalent, and a reproducible lockfile. Examples must not install packages they do
not use.

## Decision

- **pnpm 10.26.1 workspaces** (`packageManager` field) over `packages/*` and
  `examples/*`. Internal edges use `workspace:*` and are rewritten to versions by
  `pnpm pack`. `minimumReleaseAge: 1440` delays newly published versions by a day, and
  `onlyBuiltDependencies` allows install scripts for `esbuild` only.
- **Each example declares only what it uses**, so the HBS starter installs no React,
  Vue, Svelte or Vite.
- **One `tsc -p tsconfig.json` per package**, run in dependency order by
  `pnpm -r --sort build`. Packages extend `tsconfig.base.json` (strict,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, NodeNext, declaration and
  source maps). No project references: each package compiles against its
  dependencies' emitted `.d.ts`, which is what consumers see.
- **Tests live at the repository root** (`tests/`), run by one Vitest config with
  named groups (`test:unit`, `test:integration`, `test:security`) and one Playwright
  config. Cross-package integration tests are the norm, and a root suite avoids
  duplicated fixtures.
- **Repository scripts instead of plugins** (`scripts/*.mjs`): boundaries, pack and
  external consumers, size budget, docs, ledger, release and checkpoint gates. Each is
  a plain Node script that CI calls through `package.json`.
- **Changesets 3.0.3** for versioning; release is owner-authorised
  ([ADR 0007](0007-packaging-and-release.md)).

## Alternatives rejected

- **Turborepo / Nx.** A full build of 28 packages takes minutes, and CI always
  rebuilds from a clean checkout, so remote caching would be the main win. That needs
  a hosted cache account the owner has not provided, plus another tool and config
  format.
- **TypeScript project references with `tsc -b`.** They give incremental builds, but
  each package would need composite settings and reference lists that duplicate
  `package.json` dependencies and drift from them. Compiling against emitted
  declarations also catches broken public types before consumers do.
- **npm or Yarn workspaces.** pnpm's strict `node_modules` layout surfaces undeclared
  dependencies that hoisting would hide, which matters for publishable packages.

## Consequences

- A change to a low-level package needs a rebuild of its dependents before tests see
  it (`pnpm --filter <pkg>... build`).
- No build cache: a full `pnpm build` in CI on every run.
- Root-level tests mean `pnpm --filter <pkg> test` runs only the subset each package
  lists; the canonical gates are the root scripts listed in the
  [test matrix](../contributing/test-matrix.md).
- Revisit if full CI time becomes the bottleneck, or if an owner-approved remote
  cache becomes available.
