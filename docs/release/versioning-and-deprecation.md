# Versioning and deprecation policy

Status: proposed for 1.0 (2026-11-06; LTS/backport rules added 2026-11-14). It takes effect with the first `1.0.0`
publication; until then every artifact is `0.1.0-alpha.*` and experimental (see
[SECURITY.md](../../SECURITY.md)). It refines
[ADR 0008](../adr/0008-compatibility-and-upgrades.md).

## Coordinated versions

`nestvexa` and every public `@nestvexa/*` package release together with one
version number (a Changesets `fixed` group in `.changeset/config.json`). A patch
of one package bumps all of them; mixed versions of Nestvexa packages in one
application are unsupported. Private workspace examples are never versioned.

## What semver covers

Semantic Versioning 2.0.0 applies to the **public surface**:

- every documented `exports` entry and its TypeScript declarations;
- decorators, module options, directive names (`nv:*`) and modifiers;
- the Live wire protocol (`nestvexa-live/<major>`), the text-stream protocol,
  the server-actions envelope and generated client shape;
- documented error codes, HTTP statuses and response headers;
- CLI commands, flags and generated file layout;
- Node, NestJS, TypeScript and peer-dependency support ranges.

Not covered: anything under `src/internal`, undocumented exports, exact error
message text, log/span wording, HTML whitespace, timings and bundle bytes
within the budget in [ADR 0020](../adr/0020-client-budget-revision.md).

| Change                                                          | Release |
| --------------------------------------------------------------- | ------- |
| Bug or security fix without public-surface change               | patch   |
| New export, option, directive, error code or peer major added   | minor   |
| Removed/renamed API, changed default, protocol major, peer drop | major   |
| Dropping a Node LTS line or NestJS major                        | major   |

A security fix may tighten validation in a patch (for example rejecting input
that could crash a process) when the previous behavior was unsafe. Such changes
are called out in the changeset and release notes.

## Protocol compatibility

The browser runtime and server must share a Live protocol major. A server
rejects an unsupported major with `426 UNSUPPORTED_PROTOCOL` and the client
reloads. Protocol minors are additive and negotiated through capability headers
(for example `x-nestvexa-capabilities: renderless-v1`). Snapshots never survive
a deploy that changes component state schemas; they fail closed with
`409 STATE_SCHEMA_CHANGED`.

## Deprecation

1. Mark the API with `@deprecated` JSDoc naming the replacement and the
   earliest removal version, add a changeset and a migration-guide entry.
2. Emit at most one runtime warning per process through the Nest logger (never
   per request), and only where detection is cheap and certain.
3. Keep the deprecated API working for **at least one minor release and at
   least 90 days**, whichever is longer, before removal in the next major (the
   window set in [GOVERNANCE.md](../../GOVERNANCE.md#compatibility-and-deprecation)).
4. Security exceptions: an API that cannot be made safe may be removed or
   disabled in a minor or patch with an advisory.

## Support windows

- The latest minor of the current major receives fixes. After a new major, the
  previous major receives security fixes for 6 months.
- Supported runtimes: maintained Node LTS lines (22 and 24 at 1.0), NestJS 12,
  TypeScript 6 and the browser versions in the tested matrix. Support for a line
  ends no earlier than its upstream end of life.

## LTS lines and backports

There is no long-term-support (LTS) line before 1.0, and none is promised
for 1.0 itself. "LTS" in this document refers only to Node.js LTS lines. The
support windows above are the whole commitment:

- **Where fixes land.** Every fix lands on `main` first, with a test and a
  changeset. A fix for an older line is a cherry-pick of that commit onto a
  maintenance branch `release/<major>.x`. The branch is created from the last
  tag of that major when the first backport is needed. A backport never
  contains changes that are not on `main`.
- **What is backported.** To the previous major, during its 6-month window:
  security fixes (P0–P2) and fixes for data loss or cross-tenant exposure.
  Nothing else. To the latest minor of the current major: every patch-level
  fix. Features are never backported.
- **How it ships.** The maintenance branch has its own changesets and its own
  coordinated patch version of every package. It is published through the
  same [release workflow](release-process.md) from a `v<major>.<minor>.<patch>`
  tag. Because the dist-tag `latest` must stay on the current major, a
  backport release passes `--tag v<major>-lts` instead. That flag must be
  added to `scripts/release-publish.mjs` before the first backport release.
- **Ending a line.** When a window ends, the last release of that line is
  announced in the changelog and the security policy table, and
  `npm deprecate` is not used for supported-but-old versions.

## Release cadence

Patch releases as needed; minors roughly monthly when changes are ready; majors
at most yearly, each with a migration guide (template:
[migration-1.0.md](migration-1.0.md)). Every release goes through
[the release process](release-process.md); nothing is published automatically.
