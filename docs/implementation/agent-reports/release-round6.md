# Release engineering and process rows: round 6

This round covered branch `r6-release`, worktree
`C:/Users/eslam/Desktop/nv-wt/release`. The branch started from main
`1131243` and merged main `bb1527b`. It audited the REL, MAINT, REVIEW,
REPORT, LEDGER and EXEC groups (132 rows) and filled the release and
maintenance gaps that do not need the owner.

The row-by-row audit is in
`.claude/coordination/ledger-audit-process.json` (not committed). Each row
has these fields: `state`, `implementationFiles`, `testFiles`, `docs`,
`examples`, `outstandingIssues` and `securityNotes`. Every cited path was
checked to exist on this branch, except this report, which the audit cites
before it is committed.

**Result: 12 Done, 120 InProgress.**

- Done: LEDGER-003, LEDGER-024, REVIEW-004, REVIEW-005, REVIEW-006,
  REVIEW-007, REVIEW-009, REVIEW-010, REVIEW-012, REVIEW-013, REVIEW-014 and
  MAINT-011.
- No REL row is Done.

Nothing was published, tagged or pushed. No independent security review
exists, and this branch claims none.

## What was implemented

| Piece                                                               | Rows                                  | Tests                                                                               |
| ------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `scripts/release-dry-run.mjs` (`pnpm release:dry-run [--pack]`)     | REL-035, MAINT-017                    | `tests/release-tooling.test.ts` (a real `changeset version` in a remote-less clone) |
| `.github/workflows/release-dry-run.yml` (weekly or manual)          | REL-035                               | `tests/release-gate.test.ts` (no id-token, environment or secrets)                  |
| `scripts/release-notes.mjs` (`pnpm release:notes`)                  | MAINT-017, REL-035                    | `tests/release-tooling.test.ts`                                                     |
| `scripts/release-publish.mjs` refactored into tested functions      | REL-034, REL-035                      | `tests/release-tooling.test.ts`                                                     |
| SBOM generation tests (`scripts/sbom.mjs` was untested)             | REL-035, REPORT-007                   | `tests/release-tooling.test.ts`                                                     |
| `release-check` gate tests                                          | REL-002, REL-021, REL-035, REPORT-003 | `tests/release-gate.test.ts` (1 pass case, 12 refusal cases)                        |
| Release workflow posture tests                                      | REL-035                               | `tests/release-gate.test.ts`                                                        |
| Repository-wide stub and skip check                                 | REL-026, LEDGER-025                   | `tests/release-gate.test.ts`                                                        |
| `scripts/pack.mjs`: every `bin` packed; secret scan of packed files | REL-020, REL-033, REVIEW-019          | proven only by `pnpm test:pack` (see below)                                         |
| `docs/release/release-checklist.md`                                 | REL-035, REPORT-009, MAINT-010        | n/a                                                                                 |
| LTS and backport rules                                              | MAINT-010, REPORT-010                 | n/a                                                                                 |
| `docs/release/architecture-review.md`: 20 section-28 answers        | REVIEW-002..023                       | cites existing tests                                                                |
| Issue templates: platform, migration, security/privacy/perf, tests  | MAINT-012                             | n/a                                                                                 |
| GOVERNANCE.md: stale "migrate does nothing" and plugin SDK notes    | MAINT-006, MAINT-018                  | n/a                                                                                 |

### What each piece does

- **Release dry run.** `release-dry-run.mjs` clones `HEAD` into a temp
  directory and removes `origin`, so the clone cannot push. It links the
  workspace `node_modules` and runs `changeset version`. It then checks:
  - one new version for every public package;
  - a `CHANGELOG.md` entry for each package;
  - private examples keep their versions;
  - every changeset was consumed.

  It writes `artifacts/release/dry-run.json` plus note drafts. With `--pack`
  it also does `pnpm install`, `pnpm build` and `pnpm test:pack` in the
  clone, then `release-publish.mjs --dry-run`, which runs
  `npm publish <tgz> --provenance --access public --dry-run` in dependency
  order. The clone's `pack.json` and SBOMs are copied out.

  The tooling link is removed with `unlink` before any recursive delete, so
  the workspace `node_modules` is never touched. The test checks this.

- **Dry-run workflow.** `release-dry-run.yml` has `contents: read` only. It
  has no `id-token`, no environment and no secrets, and the checkout does not
  persist credentials. It runs `release:prepare` and then
  `release:dry-run --pack`, and uploads `artifacts/release/`.

- **Release notes.** `release-notes.mjs` parses `.changeset/*.md` and rejects
  malformed front matter, unknown bump types and empty summaries. It writes:
  - `release-notes.md`: Security, then Breaking, Features and Fixes.
  - `migration-notes.md`: Breaking, Security, Deprecations and Changed
    defaults tables. Their action and test cells say _TO FILL_.
  - `release-notes.json`.

  It flags entries mechanically. A maintainer completes
  `docs/release/migration-<major>.0.md`.

- **Publish script.** `release-publish.mjs` now exports `parseArgs`,
  `verifyTarballs`, `publishOrder` and `publishArguments`. The tests cover
  SHA-256 re-verification, version and tag drift, `workspace:` ranges,
  renamed manifests, cycles and prerelease `--tag next`.

  It also fixes a Windows bug. The publish call spawned `npm` without a
  shell, which fails on Windows because `npm` is a `.cmd` shim, so local dry
  runs could not work. Every argument is now restricted to shell-inert
  characters before the shell is used.

- **SBOM tests.** They check that only v9 lockfiles are accepted, and that
  `@nestvexa/views` gets:
  - its runtime closure, with no devDependencies;
  - SHA-512 registry hashes;
  - peers with `optional` scope;
  - the tarball SHA-256 in `metadata.component`;
  - a deterministic output.

- **`release-check` gate tests.** They run the real script against a fixture
  workspace with complete evidence. It passes, and `publicationAuthorized`
  stays `false`. It refuses in each of these cases:
  - missing `security-review.json`;
  - no independent reviewer;
  - an open P1;
  - a P0 that is only "accepted";
  - the review is not approved;
  - the reviewed commit is not exact;
  - the SBOM does not hash the tarball;
  - the SBOM file drifted;
  - no Windows matrix entry;
  - an advisory load gate;
  - skipped e2e tests;
  - an open phase;
  - a stale ledger.

  The tests also assert that `docs/release/evidence/security-review.json` is
  not committed.

- **Workflow posture tests.** `release.yml` has exactly the matrix, verify and
  publish jobs, with no tokens or secrets. Only the publish job has
  `id-token: write`, and it needs `environment: npm-release`. The
  security-review copy runs before `pnpm release:check`. `dry_run` defaults
  to true.

- **Stub and skip check.** The test fails on:
  - `TODO`, `FIXME` or a not-implemented throw in `packages/*/src` or
    `scripts`;
  - `.skip`, `.only` or `.todo` in vitest tests;
  - `.only` or `.fixme` in Playwright specs.

  All pass today.

- **Architecture review answers.** Every answer cites code and tests, and
  every path was verified. The research was helped by a read-only explore
  pass; the key test names were spot-checked by grep.

### What the local dry run showed

`pnpm release:dry-run` ran without `--pack` on `HEAD` `1131243`: no
blockers. The 30 public packages go from `0.1.0-alpha.0` to **`0.1.0`**.

Changesets is not in pre mode. Unless the owner runs
`pnpm changeset pre enter alpha`, the next release would be stable `0.1.0`
rather than `0.1.0-alpha.1`. The checklist and release process now say so.

The notes generator found 111 pending changesets. It flagged 17 as
security-relevant, 2 as breaking, 2 as deprecations and 26 as changing
defaults.

## Findings the coordinator must act on

1. **The release gate fails on every full e2e run.**
   - `tests/browser/lifecycle-leaks.spec.ts:232` has a conditional
     `test.skip(browserName !== 'chromium')`.
   - Across three browsers, Playwright reports 2 skipped tests.
   - `release-check` requires `stats.skipped === 0`.
   - Fix it in the QA or browser area: limit the test to the chromium project
     (for example a `@chromium-only` tag with `grepInvert` on the firefox and
     webkit projects in `playwright.config.ts`) instead of skipping it.
2. **The ledger lags the audits.**
   - Main has 96 Done rows.
   - Re-audit 2 (179 Done) and this audit are not yet merged.
   - `pnpm ledger:check` and `node scripts/ledger.mjs --self-test` are not CI
     steps.
3. **FINAL_RELEASE_REPORT.md and STATUS.md are stale** (2026-11-02). See the
   suggested content below.

## Content for FINAL_RELEASE_REPORT.md, STATUS.md and progress.json

The coordinator updates these files; nothing below has been written into
them.

### A. Status

**NOT YET READY — BLOCKERS.** `pnpm release:check` refuses, as intended:

- phases are not all Done;
- the ledger is incomplete;
- `security-review.json` is absent.

No Nestvexa package is on the public registry: `npm view nestvexa` and
`npm view @nestvexa/core` returned E404 on 2026-11-14. The 0.1.0-alpha.0
preview was never published.

### B. What exists

- 30 public packages at `0.1.0-alpha.0`, including `@nestvexa/mail` and
  `@nestvexa/realtime-redis`, which the 11-02 report omits. They form one
  Changesets fixed group.
- More than 40 examples.

### E. Artifacts

- `pnpm test:pack` writes the tarballs and a CycloneDX 1.6 SBOM per tarball
  (`artifacts/sbom/`). The old "Not produced: no SBOM" line is wrong.
- `pnpm release:dry-run` writes `artifacts/release/` (dry-run report, notes
  drafts and, with `--pack`, the clone's `pack.json` and SBOMs).
- npm provenance is configured in `release.yml`, but no attestation exists,
  because nothing was published.

### Release tooling (new section)

| Command or workflow        | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `release:prepare`          | Plan the release                                                      |
| `release:dry-run [--pack]` | Temp-clone versioning, pack, and `npm publish --dry-run --provenance` |
| `release:notes`            | Release and migration note drafts                                     |
| `release:check`            | The gate; tested                                                      |
| `release.yml`              | Owner-dispatched matrix, verify, then publish behind `npm-release`    |
| `release-dry-run.yml`      | Weekly, cannot publish                                                |

### F. Known issues

| Severity | Issue                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| P1       | Server-action idempotency is process-local; a retry can run twice across restarts or replicas (REVIEW-016) |
| P2       | `@nestvexa/cache` has no Redis store (REVIEW-017)                                                          |
| P2       | Live has no secret-like `@State` key guard (REVIEW-008)                                                    |
| P2       | Release gate vs the Playwright conditional skip (finding 1 above)                                          |
| P3       | No comparative performance baseline (REVIEW-021)                                                           |
| P3       | No runtime deprecation-warning helper (MAINT-017)                                                          |
| P3       | No third-party adapter package proven from tarballs (MAINT-007)                                            |
| P3       | Upstream snapshot is from 2026-11-05: Nest 12.3, Inertia 3.11 and Node 26 are untested (MAINT-019)         |

### G. Owner actions

Each of these is listed in `docs/release/release-checklist.md`.

1. Verify ownership of the `nestvexa` npm name and the `@nestvexa` scope
   (currently 404).
2. Do a trademark review, and a legal review of `LICENSE` and
   `THIRD_PARTY_NOTICES.md`.
3. Configure npm trusted publishers: this repository, `release.yml`,
   environment `npm-release`. Then disallow token publishing and keep npm 2FA.
4. Create the GitHub environment `npm-release` with required reviewers and a
   `v*` tag rule.
5. Set branch protection on `main`: required CI and CODEOWNERS review, auto
   merge off, secret scanning, push protection and private vulnerability
   reporting.
6. Commission the independent third-party security review and commit
   `docs/release/evidence/security-review.json`.
7. Decide on prerelease mode (`changeset pre enter alpha`) or a stable
   `0.1.0`.
8. Approve the version and tag, run the Release workflow with
   `dry_run: true` and then `false`, and verify with `npm audit signatures`.
9. Accept or reject the coordinated-version policy as the answer to the
   spec's "independent package versioning" (MAINT-016).

### H. Maintenance

The policy is in `docs/release/versioning-and-deprecation.md`:

- semver on one coordinated version;
- deprecation for one minor and 90 days;
- the previous major gets security fixes for 6 months;
- the new LTS/backport rules: fixes land on `main` first and are
  cherry-picked to `release/<major>.x`; there is no LTS line before or at 1.0.

## Remaining gaps by row

Every InProgress row lists its concrete missing pieces in the audit JSON. The
main ones not caused by other groups:

- REL-004: no packed-bin `nestvexa init` run in a fresh Nest app.
- REL-027: no inventory of `globalThis` uses.
- REL-033: per-subpath `.d.ts` checks are missing.
- REL-035: the dry-run workflow has never run on GitHub, and the migration
  guide is still a template.
- REVIEW-018: no enforced umbrella dependency deny-list.
- MAINT-007: third-party adapter from tarballs.
- MAINT-010: commitlint and changeset checks in CI.
- MAINT-017: a runtime deprecation helper (core, kernel area).
- MAINT-018: no directive codemod example.
- LEDGER-025: no TODO detection for Done evidence inside `ledger.mjs`, and
  `ledger.mjs` is not tested in CI.

## Commands run

| Command                                                   | Result                                                    |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm build`            | exit 0                                                    |
| `node scripts/ledger.mjs check`, `--self-test`            | exit 0 (925 rows, 96 Done)                                |
| `pnpm release:dry-run` (without `--pack`)                 | exit 0, 30 packages `0.1.0-alpha.0` → `0.1.0`, 4 min 16 s |
| `pnpm release:notes` (to scratch)                         | 111 changesets parsed                                     |
| `pnpm exec vitest run tests/release-gate.test.ts`         | 19 passed                                                 |
| `pnpm exec vitest run tests/release-tooling.test.ts`      | 13 passed                                                 |
| `pnpm exec vitest run tests/supply-chain-scripts.test.ts` | 29 passed                                                 |
| `pnpm exec eslint` on the changed files                   | exit 0                                                    |
| `pnpm exec tsc -p tsconfig.tests.json --noEmit`           | exit 0                                                    |
| `pnpm exec prettier --check` on the changed files         | exit 0                                                    |
| `npm view nestvexa` / `npm view @nestvexa/core`           | E404                                                      |

| `pnpm build` after merging `bb1527b`, then `tsc -p tsconfig.tests.json` | exit 0 |
| `pnpm test:pack` from Git Bash | fails before packing: Git Bash's GNU `tar` reads `C:\...` as a remote host. This is an environment issue; use PowerShell or cmd (Windows `tar.exe`) |
| `pnpm test:pack` from PowerShell (523 s) | exit 1, failure **inherited from main** (details below) |

### The `pnpm test:pack` run

All 30 tarballs were packed and inspected. The new checks passed with no
findings:

- every `bin` target is present;
- no packed file has credential-shaped content.

The SBOMs were written. The pnpm _full_ consumer passed: MVC, Live,
Inertia, uploads, the optional engines, and actions with React, Vue,
Svelte and Live bindings.

The pnpm _minimal_ consumer then failed at
`tests/pack-consumers/assets.ts:114`:
`assert.equal(Object.keys(manifest.files).length, 3)` got 7.

- **Cause:** the umbrella asset manifest gained files from the
  client-feature-chunks and kernel round-5 merges on main.
- **This branch:** does not touch `assets.ts` or the umbrella.
- **Consequence:** `pnpm test:pack`, and therefore CI and `release.yml`, are
  red on main `bb1527b`. Packing itself is not the problem.
- **Fix:** the client/umbrella owner must decide whether the expected asset
  count should be 7 (and list the files) or whether chunks leak into the
  default manifest.

**Coordinator finding 4.**

**Coordinator finding 5.** `pnpm test:pack` copies the root
`THIRD_PARTY_NOTICES.md` into `packages/nestvexa/`. On main, the committed
copy differs from the root file. I restored it and did not commit it,
because it is out of scope here. Commit the refreshed copy on main, or
gitignore it.
