# Release process

Publishing, tags and remote pushes require **explicit owner authorisation**
([governance](../../GOVERNANCE.md)). Contributors prepare changes; maintainers prepare
releases; the owner publishes.

## Versioning

- All packages are `0.1.0-alpha.0` today. Pre-1.0 releases may break public API
  between minor versions; every break needs a Changeset that says so and a migration
  note.
- From 1.0, packages follow semver. Breaking changes ship only in majors, after a
  deprecation period (see [governance](../../GOVERNANCE.md#compatibility-and-deprecation)).
- The Live wire protocol is versioned separately (`nestvexa-live/1`). A protocol
  change needs a new protocol version and a reload or migration path
  ([ADR 0002](../adr/0002-live-protocol.md), [ADR 0008](../adr/0008-compatibility-and-upgrades.md)).
- Packages are versioned independently. Changesets bumps internal dependents (patch)
  when a dependency changes (`updateInternalDependencies: patch` in
  `.changeset/config.json`).

## Changesets

Every pull request that changes published behaviour adds a file under `.changeset/`:

```md
---
'@nestvexa/live': patch
---

One sentence describing the user-visible change, written for the changelog.
```

Use `minor` for features and `patch` for fixes before 1.0. Docs-only or test-only
changes need no Changeset. `pnpm changeset` creates the file interactively.

## Preparing a release (maintainer)

1. Confirm `main` is green in CI on all four matrix jobs.
2. `pnpm changeset version` to apply pending Changesets, bump versions and write each
   package `CHANGELOG.md`. Review the diff and commit it.
3. Run the full gate locally or with the manual
   [release workflow](../../.github/workflows/release.yml): `pnpm test:all`. It ends
   with `pnpm release:check`, which fails until every phase in `progress.json` is Done
   and every evidence report (`vitest.json`, `playwright.json`, `pack.json`,
   `release-matrix.json`, `security-review.json`) is green.
4. `pnpm test:pack` writes the tarballs to `artifacts/packages/`. The release workflow
   uploads them as `owner-review-tarballs` for inspection.

## Publishing (owner only)

The owner reviews the tarballs, then publishes them with npm provenance from an
authorised account, creates the git tag and pushes it. No workflow in this repository
publishes or pushes automatically, and none holds registry credentials.

> **Known gap:** on 2026-11-05, `npm view nestvexa` and `npm view @nestvexa/core` both
> return 404 from the public registry. [Implementation status](../implementation/STATUS.md)
> says an alpha preview was published under the `alpha` tag, but the registry does
> not show it. Until the owner confirms the publication (or publishes),
> install instructions must use the local tarballs from `pnpm test:pack`. SBOM
> generation is not automated.

## After a release

- Move the released Changesets' notes into the root [CHANGELOG](../../CHANGELOG.md)
  summary if the release is user-visible.
- Update [upstream compatibility](../architecture/upstream-compatibility.md) with the
  tested matrix for that release.
- Security fixes follow [SECURITY.md](../../SECURITY.md): coordinated disclosure
  through a GitHub security advisory before the fixed version is announced.
