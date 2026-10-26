# ADR 0007: Local artifacts before publication

Status: accepted.

Use pnpm workspaces and `workspace:*` internal edges, converted by pack to release versions. Export only tested package roots. Publish `dist`, README and LICENSE. Version initial artifacts `0.1.0-alpha.0`, with no production maturity claim. Changesets is installed for later owner-reviewed version changes.

Rejected: publishing packages individually before consumer tests or automatically pushing tags. Package names, npm scope ownership and repository URLs require owner verification. Local tarball consumers resolve all workspace packages from supplied files; they do not depend on reserved registry names being available.

Failure modes are dangling workspace references, missing declarations and omitted assets. [Pack tests](../../scripts/pack.mjs) inspect archive contents and boot a real external Nest app. A complete release remains gated by [release check](../../scripts/release-check.mjs); no automatic publication workflow is enabled.
