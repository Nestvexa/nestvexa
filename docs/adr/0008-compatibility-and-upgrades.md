# ADR 0008: Evidence-based compatibility and explicit upgrade boundaries

Date: 2026-10-25. Status: **initial toolchain policy accepted; full compatibility matrix pending**.

## Decision

Pin implementation dependencies and package-manager version through manifests and lockfile. Select a mutually compatible toolchain, not the largest independent version of each package. The initial selection uses Nest 12.2.0 and TypeScript 6.0.3: TypeScript 7 is newer, but the selected typescript-eslint range excludes it. See the [upstream research record](../architecture/upstream-compatibility.md). Dependency range declarations describe an intended consumer range; only stored run evidence establishes tested combinations.

Node 22 and 24 are intended maintained-LTS targets. Windows/Node24 execution does not establish Linux or Node22 support. Run pairwise smoke checks during development and the full critical Node/OS/adapter/browser matrix before release. Express and Fastify share public behavior where proven; platform-specific capabilities and errors remain visible.

Keep the Live protocol major explicit and reject unsupported majors with a stable reload/upgrade path. Client/server asset versions must be negotiated before interpreting changed payloads. Do not silently reinterpret an old snapshot/reference after state-schema changes. Component schema migrations need deliberate versioning or invalidation. Public API changes require a changeset, updated examples and migration notes; pre-1.0 status is not permission to silently break users.

Use ESM-only package roots initially to avoid duplicate singleton identities. Packed external consumers must verify exports, declarations and peer resolution without monorepo aliases. Optional frontend packages must not make the HBS consumer install all renderers. Official Inertia/client compatibility is selected and tested when that implementation begins; v3 docs are research, not a support badge.

## Alternatives and consequences

Broad untested peers were rejected because a successful compile cannot establish runtime semantics. Automatic latest-version adoption was rejected because security/tool/compiler changes can break contracts. Pinning forever was rejected because advisories and end-of-life schedules require active maintenance. Narrow initial support costs upgrade/matrix work but makes failures attributable.

Runtime-critical dependency updates require scoped regression tests plus integration/pack verification. A workspace override is not a downstream security guarantee: inspect the effective dependency in each clean consumer. The Multer 2.5.0 fix illustrates why audit, lockfile and published-consumer policy must agree.

## Environment and evidence

On 2026-10-25, `docker info --format '{{.OSType}}'` failed with exit 1 because `dockerDesktopLinuxEngine` was unavailable. The local Linux-container gate is **environment-blocked**; Docker Desktop being installed is not a successful Linux run. Do not start a daemon or claim a matrix result from that failure. A functioning Linux runner/container is still needed.

[Integration tests](../../tests/integration.test.ts), [package contract tests](../../tests/contracts.test.ts) and [pack verification](../../scripts/pack.mjs) cover parts of the initial surface. Full API snapshots, multi-compiler/Node/OS tests, migrations and optional-renderer matrix remain pending.
