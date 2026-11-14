# Release checklist

Use this list for every release, together with the
[release process](release-process.md). Items marked **owner** can only be done
by the repository owner. Neither automation nor maintainers do them on the
owner's behalf ([GOVERNANCE.md](../../GOVERNANCE.md)). Nothing in this
repository publishes, tags or pushes by itself.

## One-time owner setup (before the first release)

- [ ] **owner**: confirm that you own the `nestvexa` npm package name and the
      `@nestvexa` scope. On 2026-11-14 `npm view nestvexa` and
      `npm view @nestvexa/core` returned 404, so no Nestvexa package is public.
- [ ] **owner**: do a trademark and name review for "Nestvexa".
- [ ] **owner**: have legal review `LICENSE` and `THIRD_PARTY_NOTICES.md`.
- [ ] **owner**: set up an npm trusted publisher for every package. It must
      name this repository, the workflow `release.yml` and the environment
      `npm-release`. Then disallow token publishing and require 2FA on the npm
      account.
- [ ] **owner**: create the GitHub environment `npm-release`. Give it required
      reviewers and allow deployments only from `v*` tags.
- [ ] **owner**: protect the `main` branch. Require the CI checks and CODEOWNERS
      review, and turn on secret scanning, push protection and private
      vulnerability reporting.
- [ ] **owner**: commit `docs/release/evidence/security-review.json` from an
      **independent** third-party security review (the format is in
      [evidence formats](evidence-formats.md)). The internal 2026-11 review does
      not count. `pnpm release:check` and the release workflow refuse to
      continue without this file (`tests/release-gate.test.ts`).

## Prepare (maintainer)

- [ ] Check that `main` is green on all four CI matrix jobs (Ubuntu and
      Windows × Node 22 and 24) and on the latest nightly run.
- [ ] `pnpm release:prepare --target <version>`. One coordinated version and
      one fixed group are required, and the plan must reach the target.
- [ ] If you want a prerelease, enter pre mode first
      (`pnpm changeset pre enter alpha`). Without it, the pending changesets
      version `0.1.0-alpha.0` to **`0.1.0`**, not `0.1.0-alpha.1`. The
      2026-11-14 dry run showed this.
- [ ] `pnpm release:dry-run --pack` (or run the **Release dry run** workflow).
      This runs `changeset version` in a remote-less temp clone, checks each
      CHANGELOG entry, builds and packs the tarballs with SBOMs and runs
      `npm publish --dry-run --provenance` on each one. Read
      `artifacts/release/dry-run.json`.
- [ ] Review `artifacts/release/release-notes.md` and `migration-notes.md`,
      which `pnpm release:notes` generates from the changesets. Fill every
      _TO FILL_ row in `docs/release/migration-<major>.0.md` with an action and
      the test that proves it.
- [ ] Check that every deprecation in the changesets has a `@deprecated` JSDoc
      with its replacement, and that it was announced at least one minor
      release and 90 days before any removal
      ([policy](versioning-and-deprecation.md#deprecation)).
- [ ] Run `pnpm test:all` locally, and
      `LOAD_LATENCY_GATE=enforce pnpm load` on a quiet machine.
- [ ] `pnpm changeset version` on a release branch. Review every
      `CHANGELOG.md` diff and the lockfile.
- [ ] `pnpm install --lockfile-only && pnpm test:pack && pnpm release:check`.
- [ ] Open a pull request named `chore(release): vX.Y.Z`. Get it reviewed and
      merge it.

## Publish (owner)

- [ ] **owner**: tag the merge commit `vX.Y.Z` and push the tag.
- [ ] **owner**: run **Actions → Release** with that tag and `dry_run: true`.
      Review the `release-candidate` artifact (tarballs, SBOMs, reports).
- [ ] **owner**: run it again with `dry_run: false` and approve the
      `npm-release` environment.
- [ ] **owner**: run `npm audit signatures` in a fresh project that installs
      the release, to confirm the provenance attestations.
- [ ] **owner**: create the GitHub release with the reviewed notes. Attach the
      SBOMs and link the migration guide. List security fixes first.

## After the release

- [ ] Do a fresh `npm install nestvexa@<version>` and `npx nestvexa init` in a
      new Nest app.
- [ ] Watch the issues and advisories. A harmful version is deprecated and
      fixed forward ([rollback](release-process.md#rollback-and-deprecation)).
- [ ] Update `docs/architecture/upstream-compatibility.md` with the tested
      matrix of the release.
