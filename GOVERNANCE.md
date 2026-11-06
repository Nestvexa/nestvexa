# Governance

## Roles

- **Owner** (currently the repository owner, `@eslam-reda-div`): approves
  releases, controls npm and GitHub settings, security contacts and the
  `npm-release` environment, and appoints maintainers.
- **Maintainers**: review and merge within the paths they are listed for in
  [CODEOWNERS](.github/CODEOWNERS). No maintainers beyond the owner are
  appointed yet; no person or organization is named without their consent.
- **Contributors**: anyone submitting issues or pull requests under the
  [code of conduct](CODE_OF_CONDUCT.md) and [contributing guide](CONTRIBUTING.md).

## Decisions

- Small, reviewed pull requests with Conventional Commits, tests and
  documentation for behavior changes.
- Public API, protocol or support-matrix changes need an ADR in `docs/adr/`,
  a Changeset, compatibility notes and, for breaking changes, a migration
  guide entry. New features of significant scope start as an ADR/RFC pull
  request before implementation.
- Security-sensitive paths (security docs, release scripts, workflows,
  lockfile) always require owner review, even after maintainers are appointed.
- Feature acceptance follows the master implementation specification;
  unfinished mandatory work cannot be relabeled complete through governance or
  offered as a "good first issue" substitute for delivery.

## Releases

Versioning, compatibility, deprecation windows and cadence are defined in the
[versioning and deprecation policy](docs/release/versioning-and-deprecation.md);
the steps are in the [release process](docs/release/release-process.md).
Publication, remote pushes and official tags require explicit owner
authorization; workflows publish only after manual dispatch and protected
environment approval, using npm trusted publishing with provenance.

## Dependencies

Automated update pull requests (Dependabot) run the full CI matrix and require
review; runtime-critical dependencies are never auto-merged. NestJS and
TypeScript majors require an ADR.

## Security

Vulnerabilities follow [SECURITY.md](SECURITY.md). Internal reviews are
recorded in `docs/security/`; they do not replace the independent review that
gates 1.0.
