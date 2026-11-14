# Release process

Nothing in this repository publishes automatically. Publication, tags and
pushes need explicit owner authorization ([GOVERNANCE.md](../../GOVERNANCE.md)).
Policy: [versioning and deprecation](versioning-and-deprecation.md). Evidence:
[formats](evidence-formats.md). Step list: [release checklist](release-checklist.md).

## One-time owner setup

1. **npm scope and names.** Verify ownership of `nestvexa` and the
   `@nestvexa` scope on npmjs.com.
2. **Trusted publishing (OIDC).** For every package, add a trusted publisher:
   GitHub Actions, this repository, workflow file `release.yml`, environment
   `npm-release`. Then disallow token-based publishing for the packages. The
   workflow requests `id-token: write` only in the publish job and runs
   `npm publish --provenance` with npm ≥ 11.5.1 (pinned `npm@11.21.2`); no
   `NPM_TOKEN` secret exists or is needed.
3. **Protected environment.** Create the GitHub environment `npm-release` with
   required reviewers (the owner) and a deployment rule limited to `v*` tags.
4. **Branch protection.** Require CI and CODEOWNERS review on `main`; enable
   secret scanning, push protection and private vulnerability reporting.
5. **Independent review.** Commit the independent reviewer's evidence as
   `docs/release/evidence/security-review.json` (format in
   [evidence formats](evidence-formats.md)). The release job fails without it.

## Preparing a release

```sh
pnpm release:prepare                         # pending plan, coordinated version check
pnpm release:prepare --target 1.0.0          # verify the plan reaches 1.0.0
pnpm release:prepare --target 1.0.0 --write  # add the coordinated major changeset (1.0 only)
```

`release:prepare` ([script](../../scripts/release-prepare.mjs)) verifies one
version across public packages, the Changesets fixed group, and that the
pending changesets produce exactly one next version (the target if given). It
writes `artifacts/reports/release-plan.json` and never versions or publishes.
The coordinated 1.0 major changeset is deliberately **not** committed yet.

### Dry run and notes

```sh
pnpm release:dry-run          # changeset version in a temp clone + checks + notes
pnpm release:dry-run --pack   # also install/build/test:pack and npm publish --dry-run --provenance
pnpm release:notes --from 0.1.0-alpha.0 --to 0.1.0   # notes only
```

[`release-dry-run.mjs`](../../scripts/release-dry-run.mjs) clones `HEAD` into a
temporary directory, removes the clone's `origin` remote (so nothing done in
the clone can be pushed), runs `changeset version` there and checks:

- every public package moved to one new version;
- each package has a `CHANGELOG.md` entry for that version;
- private examples kept their versions;
- every changeset was consumed.

With `--pack`, it installs, builds and runs `pnpm test:pack` in the clone, then
runs [`release-publish.mjs`](../../scripts/release-publish.mjs) `--dry-run` on
those tarballs. That is `npm publish <tarball> --provenance --access public
--dry-run` in dependency order. npm uploads nothing in dry-run mode and needs no
credential. The report goes to `artifacts/release/dry-run.json`, with the clone's
`pack.json` and SBOMs next to it.

The **Release dry run** workflow
([release-dry-run.yml](../../.github/workflows/release-dry-run.yml)) runs the
same thing weekly and on demand. It has no `id-token` permission, no
environment and no secrets, so it cannot publish.

[`release-notes.mjs`](../../scripts/release-notes.mjs) drafts
`release-notes.md` (security first, then breaking changes, features and fixes)
and `migration-notes.md` from the pending changesets. The migration draft has
tables for breaking, security-relevant, deprecation and changed-default
entries, each with _TO FILL_ action and test cells. These rows are selected
mechanically from the changeset text, so a maintainer must complete them in
`docs/release/migration-<major>.0.md`.

> **Prerelease note:** without Changesets pre mode, the pending changesets
> version `0.1.0-alpha.0` to `0.1.0`. This was observed in the 2026-11-14 dry
> run. Run `pnpm changeset pre enter alpha` first if the next release should
> be `0.1.0-alpha.1`.

Then, on a clean branch:

1. `pnpm test:all`, and `LOAD_LATENCY_GATE=enforce pnpm load` on a quiet machine.
2. Fill [the migration guide](migration-1.0.md) from the changesets.
3. `pnpm changeset version`; review every `CHANGELOG.md` diff and the lockfile.
4. `pnpm install --lockfile-only && pnpm test:pack && pnpm release:check`.
5. Commit `chore(release): vX.Y.Z`, review, merge, tag `vX.Y.Z` on the merge
   commit and push the tag (owner only).

## Publishing

Run **Actions → Release → Run workflow** with the tag and `dry_run: true`
first. The [workflow](../../.github/workflows/release.yml):

1. checks out the tag and runs the full matrix (Ubuntu and Windows × Node 22
   and 24: format, typecheck, lint, unit/integration/security, coverage, size,
   three-browser e2e, packed consumers, docs), recording one matrix entry per
   passing job;
2. builds the release candidate on Ubuntu/Node 24: tag must equal the commit
   and package version; tests, e2e, `test:pack` (tarballs and CycloneDX SBOMs),
   `pnpm audit --audit-level high`, enforced load gates, merged release matrix,
   owner security evidence, then `pnpm release:check`;
3. waits for `npm-release` approval, re-verifies every tarball's SHA-256 and
   manifest against `pack.json`, and publishes in workspace dependency order
   with provenance ([release-publish.mjs](../../scripts/release-publish.mjs)).
   Prerelease versions publish under the `next` dist-tag.

Repeat with `dry_run: false` after reviewing the dry run. SBOMs and reports
stay attached to the run as the `release-candidate` artifact; attach them to
the GitHub release notes.

## Release notes

Use the aggregated changelog entries; lead with security fixes and breaking
changes; link the migration guide, SBOMs and provenance (npm shows a
provenance badge per version).

## Rollback and deprecation

npm versions cannot be overwritten, and unpublishing is restricted. Prefer
**fix forward**: release a patch. If a version is harmful:

1. `npm deprecate <pkg>@<version> "<reason>; upgrade to <fixed>"` for every
   coordinated package of that version;
2. move `latest` back if needed: `npm dist-tag add <pkg>@<good> latest`;
3. publish a GitHub security advisory when users are at risk;
4. if publishing stops part way (the publish order guarantees dependencies
   are published first), finish with a new patch version of all packages;
   never republish a partial set under different contents.

## Package order

Publishing follows workspace dependencies (for example `@nestvexa/core` before
`@nestvexa/views`, engines and `@nestvexa/live`, and every package before the
`nestvexa` umbrella). The order is computed from the packed manifests at
publish time, not maintained by hand.
