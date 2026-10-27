# ADR 0007: Local artifacts before publication

Status: accepted.

Use pnpm workspaces and `workspace:*` internal edges, converted by pack to release versions. Export only tested package roots and explicit subpaths. Publish `dist`, README and LICENSE, plus the umbrella's third-party browser notice. Version initial artifacts `0.1.0-alpha.0`, with no production maturity claim. Changesets is installed for later owner-reviewed version changes.

Rejected: publishing packages individually before consumer tests or automatically pushing tags. Package names, npm scope ownership and repository URLs require owner verification. Local tarball consumers resolve all workspace packages from supplied files; they do not depend on reserved registry names being available.

Failure modes are dangling workspace references, missing declarations and omitted assets. [Pack tests](../../scripts/pack.mjs) inspect archive contents and boot a real external Nest app. A complete release remains gated by [release check](../../scripts/release-check.mjs); no automatic publication workflow is enabled.

The `nestvexa/assets` subpath explicitly registers an application-local immutable catalog of installed client, Alpine adapter and Alpine CSP modules. The umbrella declares those dependencies; core retains no browser dependency. Content-hash URLs preserve relative ESM imports and permit immutable caching without copying browser code into server source. Native version-neutral Nest routes retain the host pipeline; a public `StreamableFile` response avoids Express independently reinterpreting conditional headers. Strict whole-list ETag parsing prevents punctuation within a quoted tag from becoming a wildcard. Only approved map entries are served, and snapshots clear at shutdown.

Rejected: a filesystem wildcard route, a manual route per module, and eager browser startup on package import. The chosen approach costs one per-application memory snapshot and a small request buffer. Editing installed files requires restart; old snapshot URLs are not retained automatically across deploys. SRI, compression, CDN retention, Vite/HMR and automatic Live/Alpine bootstrap remain separate work. The [asset corpus](../../tests/assets.test.ts), [three-browser scenario](../../tests/browser/assets.spec.ts) and [minimal packed consumer](../../tests/pack-consumers/assets.ts) define applicable acceptance checks; recorded execution results belong in [status](../implementation/STATUS.md).
