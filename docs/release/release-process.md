# Release process

Nothing in this repository publishes automatically. Publication, tags and
pushes need explicit owner authorization ([GOVERNANCE.md](../../GOVERNANCE.md)).
Policy: [versioning and deprecation](versioning-and-deprecation.md). Evidence:
[formats](evidence-formats.md).

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
