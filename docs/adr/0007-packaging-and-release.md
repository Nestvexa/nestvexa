# ADR 0007: Local artifacts before publication

Status: accepted.

Use pnpm workspaces and `workspace:*` internal edges, converted by pack to release versions. Export only tested package roots and explicit subpaths. Publish `dist`, README and LICENSE, plus the umbrella's third-party browser notice. Version initial artifacts `0.1.0-alpha.0`, with no production maturity claim. Changesets is installed for later owner-reviewed version changes.

Rejected: publishing packages individually before consumer tests or automatically pushing tags. Package names, npm scope ownership and repository URLs require owner verification. Local tarball consumers resolve all workspace packages from supplied files; they do not depend on reserved registry names being available.

Failure modes are dangling workspace references, missing declarations and omitted assets. [Pack tests](../../scripts/pack.mjs) inspect archive contents and boot a real external Nest app. A complete release remains gated by [release check](../../scripts/release-check.mjs); no automatic publication workflow is enabled.

The `nestvexa/assets` subpath explicitly registers an application-local immutable catalog of installed client, Alpine adapter and Alpine CSP modules. The umbrella declares those dependencies; core retains no browser dependency. Content-hash URLs preserve relative ESM imports and permit immutable caching without copying browser code into server source. Native version-neutral Nest routes retain the host pipeline; a public `StreamableFile` response avoids Express independently reinterpreting conditional headers. Strict whole-list ETag parsing prevents punctuation within a quoted tag from becoming a wildcard. Only approved map entries are served, and snapshots clear at shutdown.

Rejected: a filesystem wildcard route, a manual route per module, and eager browser startup on package import. The chosen approach costs one per-application memory snapshot and a small request buffer. Editing installed files requires restart; old snapshot URLs are not retained automatically across deploys. SRI, compression, CDN retention, Vite/HMR and automatic Live/Alpine bootstrap remain separate work. The [asset corpus](../../tests/assets.test.ts), [three-browser scenario](../../tests/browser/assets.spec.ts) and [minimal packed consumer](../../tests/pack-consumers/assets.ts) define applicable acceptance checks; recorded execution results belong in [status](../implementation/STATUS.md).

## Amendment (2026-11-01): CommonJS hosts

Most NestJS applications compile to CommonJS. Packages stay ESM-only, but every
`exports` entry now also has a `default` condition pointing at the same ESM file, so
Node 22.12+ (`require(esm)`) loads them from CommonJS without a dual-package build or
dual identity. Packages must therefore avoid top-level `await`. The CLI end-to-end
test (`tests/cli.test.ts`) compiles a fresh CommonJS Nest app (`module: nodenext`),
boots it and executes a Live action.

## Amendment (2026-11-14): SBOMs, provenance and license audit

- **SBOM.** `pnpm test:pack` (`scripts/pack.mjs`) writes a CycloneDX 1.6 JSON
  SBOM per public package to `artifacts/sbom/` with `scripts/sbom.mjs`. It is
  resolved offline from the committed pnpm v9 lockfile: the package itself with
  its tarball SHA-256, the runtime dependency closure at exact lockfile
  versions with registry integrity hashes, and peers as optional components
  (their closure is the application's). devDependencies never appear, and
  licenses come from installed manifests only. `artifacts/reports/pack.json`
  records each SBOM's file and SHA-256, and `scripts/release-check.mjs` fails
  when an SBOM is missing or does not match.
- **Provenance.** Publication happens only in the owner-dispatched
  `.github/workflows/release.yml`: matrix, then release-candidate verification
  (pack, SBOM, audit, load gates, release check), then the protected
  `npm-release` environment, then `scripts/release-publish.mjs`, which checks
  every tarball against the verified SHA-256 and tag version and runs
  `npm publish --provenance` through npm trusted publishing (GitHub OIDC). No
  long-lived npm token exists. Packages set `publishConfig` (`access: public`,
  `tag: alpha`). One-time owner setup is in
  [release process](../release/release-process.md).
- **License audit.** `pnpm audit:licenses` (`scripts/licenses.mjs`, run by the
  `ci` and `security` workflows) checks the production closure of every public
  package plus each declared peer against an SPDX allowlist of permissive
  licenses. Copyleft, missing, unknown or non-SPDX licenses fail unless the
  exact `package@version` is listed in `reviewed` with a written reason; the
  list is empty. `--json` writes a report. SPDX classification is unit-tested
  in `tests/supply-chain-scripts.test.ts`.

Rejected: generating SBOMs from `node_modules` (non-reproducible, includes
dev tooling) and publishing from a developer machine (no provenance, token on
disk). Remaining gate: no package is published yet; publication waits for the
owner's npm setup and the independent security review evidence.
