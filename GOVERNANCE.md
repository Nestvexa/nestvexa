# Governance

Nestvexa is an owner-led open-source project. This document says who decides what,
how decisions are recorded, and what users can rely on between versions. No person or
organisation is named as a maintainer here until the owner supplies that information.

## Roles

| Role        | Who                                                    | Can                                                                                        |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Owner       | Repository owner of `github.com/Nestvexa/nestvexa`     | Appoint maintainers, approve releases, publish to npm, push tags, own security contacts    |
| Maintainer  | Appointed by the owner; listed in `.github/CODEOWNERS` | Review and merge pull requests in their area, triage issues, prepare releases              |
| Contributor | Anyone                                                 | Open issues, discussions and pull requests under the [code of conduct](CODE_OF_CONDUCT.md) |

Publication, remote pushes, official tags and registry or account changes always need
the owner's explicit authorisation. Neither automation nor maintainers act on the
owner's behalf.

## Decision process

- **Small changes** (fixes, docs, tests, internal refactors) are decided in the pull
  request by a maintainer of the affected area.
- **Public API, protocol, security-model or dependency-policy changes** need an
  [ADR](docs/adr/README.md) in the same pull request or before it. The ADR records
  alternatives, trade-offs, failure modes, compatibility consequences and the tests
  that prove it. It also needs a Changeset and a migration note.
- **New packages or features** start as a feature-request issue. A larger one gets an
  RFC-style ADR in `Proposed` status, discussed in a pull request. It becomes
  `accepted` when a maintainer merges it.
- Disagreements are settled by the maintainers of the affected area, then by the
  owner. Decisions and their reasons stay in the ADR or pull request, not in private
  channels.

Feature acceptance follows the
[master implementation specification](NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md) and its
[feature ledger](docs/implementation/feature-ledger.md). Governance cannot relabel
unfinished mandatory work as complete, and good-first-issue labels never stand in for
required delivery.

## Pull request expectations

- Small, focused pull requests with Conventional Commit messages.
- Tests for behaviour changes; negative tests for security-relevant behaviour.
- Docs updated in the same pull request (package README, guide, and the
  [feature matrix](docs/feature-matrix.md) when status changes).
- The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) asks for reproduction,
  platform, migration notes, and security, privacy and performance implications.
- Dependency updates (Dependabot, weekly) run the full CI matrix. Runtime-critical
  packages (NestJS, Inertia clients, Alpine, template engines, frameworks) are never
  auto-merged.

## Compatibility and deprecation

- **Before 1.0** (current: `0.1.0-alpha.0`): no stability guarantee. Breaking changes
  are allowed in any release but must be listed in the Changeset and a migration note.
- **From 1.0**: semver on one coordinated version shared by `nestvexa` and every
  `@nestvexa/*` package (a Changesets fixed group). A public API stays deprecated
  for at least one minor release and 90 days before it is removed in the next major.
  Deprecations must be listed in the changelog and should warn once in development.
  Details: [versioning and deprecation policy](docs/release/versioning-and-deprecation.md).
- **Live protocol**: versioned on the wire (`nestvexa-live/1`). The server rejects any
  other protocol version; a new major needs a reload or upgrade path
  ([ADR 0008](docs/adr/0008-compatibility-and-upgrades.md)).
- **Supported platforms**: Node.js LTS lines (22, 24) and NestJS 12. Support for a
  Node line ends no earlier than its upstream end of life. Tested versions are in
  [upstream compatibility](docs/architecture/upstream-compatibility.md).

- **Migrations**: `nestvexa migrate` applies versioned, reversible, AST-based project
  migrations (`MigrationStep` in `packages/cli/src/migrate.ts`) and records them in
  `.nestvexa/manifest.json`; `--revert <id>` restores the latest one. Release and
  upgrade-note drafts are generated from changesets by `pnpm release:notes`.

> **Known gap:** there is no shared runtime deprecation-warning helper yet; deprecated
> APIs (for example `definePlugin` and `PluginRegistry` in `@nestvexa/core`) carry
> `@deprecated` JSDoc only. There are no codemods for `nv:*` directive or decorator
> renames because none has been renamed; `nestvexa migrate` is the place to add them.

## Release cadence

There is no fixed cadence before 1.0. Releases happen when the owner approves a green
[release process](docs/contributing/release-process.md) run, following the
[release checklist](docs/release/release-checklist.md). The publishing steps
(manual workflow dispatch, protected `npm-release` environment, npm trusted
publishing with provenance, SBOM per tarball) are in the
[release runbook](docs/release/release-process.md). After 1.0 the target is
a minor release roughly monthly and patch releases as needed, with security fixes
prioritised.

## Security

Vulnerabilities are reported privately as described in [SECURITY.md](SECURITY.md). The
owner controls advisory publication and disclosure timing. Internal reviews (for
example [2026-11](docs/security/internal-review-2026-11.md)) are recorded in
`docs/security/`; they do not replace the independent review that gates 1.0.
Security-sensitive paths (security docs, release scripts, workflows, lockfile) always
require owner review in [CODEOWNERS](.github/CODEOWNERS).

## Community extensions

Third-party engines, storage adapters, realtime brokers, island renderers and UI kits
should depend only on the public package exports, never on `dist` internals or
`src/internal` paths. They must declare Nestvexa packages as peer dependencies and
state the tested versions. Extensions run with full application privileges; Nestvexa
does not sandbox them. Extensions use `NestvexaExtension` / `defineExtension` from
`@nestvexa/core`, which may declare a supported `nestvexa` range checked against
`NESTVEXA_VERSION` at startup; see the core README.
