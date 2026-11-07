# Agent report: kernel integration and protocol gaps (round 4)

Branch `worktree-agent-a56b840aa68436e87`. Packages: `@nestvexa/core`,
`@nestvexa/live`, `@nestvexa/uploads`, `@nestvexa/actions`,
`@nestvexa/observability`, `@nestvexa/vite`, `@nestvexa/realtime-redis` (patch),
`nestvexa` (umbrella). New tests: `tests/core-extensions.test.ts` and
`tests/vite-integrity.test.ts` (`test:unit` and `test:security`),
`tests/kernel-integration.test.ts`, `tests/live-request-boundary.test.ts` and
`tests/assets-integrity.test.ts` (`test:integration` and `test:security`).
Changesets: `kernel-extension-model.md`, `kernel-live-policies.md`,
`kernel-uploads-policies.md`, `kernel-actions-correlation.md`,
`kernel-devtools.md`, `umbrella-kernel-wiring.md`,
`vite-subresource-integrity.md`. The package graph is unchanged
(`scripts/boundaries.mjs` still forbids `live → core`; Live and uploads use
structural interfaces, as ADR 0030 describes, and the ADR has an amendment).

## Per ledger row

### CORE-034 / CORE-023: one extension model

- `NestvexaExtension` is the one public model. It gains optional `version`
  (semver) and `nestvexa` (supported range). The range is checked against the
  new `NESTVEXA_VERSION` (`packages/core/src/version.ts`) when the extension
  host is created, so an excluded version fails startup with
  `UNSUPPORTED_CAPABILITY`.
- The semver/range code moved from `plugins.ts` to `version.ts`.
  `satisfiesVersion` is still exported from the same entry point.
- `PluginRegistry` / `definePlugin` are deprecated thin adapters (`@deprecated`
  JSDoc). `pluginExtension(plugin, { name? })` converts a plugin into an
  extension that keeps its version and range, declares each manifest
  capability as `<capability>:<name>`, and runs `setup` from `register`.
  `PluginRegistry.extensions()` hands installed plugins to
  `CoreModule.forRoot(options, { extensions })` without running `setup` a
  second time. `PluginRegistry` now defaults `frameworkVersion` to
  `NESTVEXA_VERSION`.
- Tests: `tests/core-extensions.test.ts` (version negotiation, field
  validation, plugin conversion, name derivation, no double `setup`, an
  incompatible plugin rejected through either path, and a check that
  `NESTVEXA_VERSION` equals the published core version).
  `tests/core-plugins.test.ts` and `tests/core-kernel.test.ts` still pass.
- Docs: `packages/core/README.md` (extension model and migration note),
  `docs/architecture/overview.md`.
- Gap: CORE-023 as a whole (full release matrix, CLI initializer and so on)
  is outside this round. Only the extension/plugin clause was addressed.

### CORE-043 / CORE-047 / CORE-048: kernel services wired in

- **One source of truth for policies.** `packages/live/src/security-policies.ts`
  holds the one implementation of Live's origin, CSRF, action-authorization and
  snapshot policies (`liveSecurityPolicies`). With the structural `policies`
  option (`LivePolicyRegistry`, satisfied by `SecurityPolicyRegistry`), Live
  registers those objects once under `policyOwner` (default `live`; a
  duplicate owner fails startup). It then asks the registry for every origin,
  CSRF and authorization decision: actions, `_sync`, streams, mounts and
  nested mounts. Without the option it enforces the same objects directly.
  Decisions fail closed: a throw or non-`true` result denies (implementation in `settled()`; the registry itself also catches throws). The umbrella's
  old look-alike `registerLivePolicies` copy is deleted. The umbrella now passes
  `policies: SecurityPolicyRegistry` and `requestContext: RequestContextFactory`.
  The snapshot policy reports the store's real `ttlMs`: `MemoryLiveStore` and
  `RedisLiveStore` expose it, where the old copy hard-coded 900000.
  `SecurityPolicies['csrf'].verify(request, subject?)` receives the identity
  the feature has already resolved.
- **Uploads** (`packages/uploads/src/policies.ts`): same pattern, under owner
  `uploads`. Uploads registers origin, CSRF, action-authorization and
  `upload-quota` (largest per-purpose file size, identity file count and byte
  quota) and enforces origin, CSRF-header and authorization through the
  registry. The host passes `policies` (for example by injecting
  `SecurityPolicyRegistry`), because the umbrella does not own the uploads
  module.
- **Request context.** Live spans (`admit`, `mount`, `action`) carry
  `nestvexa.request_id` from `RequestContextFactory.correlationId`. Actions
  (new `requestContext` option) adopt the kernel correlation ID as the envelope
  `requestId`, the `x-nestvexa-request-id` header, and the ID in logs and spans.
  Malformed IDs are ignored. Views get `NestvexaViewContextInterceptor`, which
  the umbrella renderer module registers: every `@Render()` model gets
  `nvRequest`, the public context (`correlationId`, `cspNonce`, `tenant`,
  `authenticated`), with the same nonce the controller sees.
- **Diagnostics in devtools.** `DevtoolsModule.registerAsync` plus the
  structural `kernel` option add registered policies (configuration data only,
  never functions), declared capabilities and recent kernel diagnostics to the
  panel and `data.json` (`kernel` field). The `*rest` catch-all controller
  route, which Fastify rejected, is removed. Unknown paths still answer 404
  (`tests/devtools-inspector.test.ts`).
- Tests: `tests/kernel-integration.test.ts` runs on real Express **and**
  Fastify servers:
  - Live registers once and enforces only what the registry decides: a
    registry that denies the origin, CSRF or authorization decision blocks the request, and the owner cannot be registered twice.
  - Live spans carry the correlation ID.
  - Uploads register quotas and are enforced through the registry.
  - Views read `nvRequest` and the CSP nonce matches the controller's.
  - Devtools shows policies, capabilities and diagnostics without secrets.
  - Actions use the correlation ID.
- Docs: ADR 0030 amendment, `docs/architecture/overview.md`,
  `docs/guides/observability.md`, and the READMEs of live, uploads, actions,
  observability and nestvexa.
- Gaps:
  - The uploads form-field CSRF path (`multipart` progressive forms) still
    compares the form token directly, because the registry CSRF contract reads
    the header.
  - The umbrella does not auto-wire `UploadsModule` or `ActionsModule`; the
    host passes the registry/context.
  - Devtools is not auto-registered.

### CORE-045: Subresource Integrity

- `@nestvexa/vite`: `integrity: true | 'sha256' | 'sha384' | 'sha512'` on a
  `ViteAssets` app hashes the built scripts, stylesheets and preloads once, at
  manifest-read time. It reads from `outDir`, which defaults to the parent of
  `.vite/`, and uses only manifest-validated paths. A missing file, unknown
  algorithm or missing `outDir` fails startup. Tags carry `integrity` and
  `crossorigin` (`anonymous` unless configured). New exports:
  `subresourceIntegrity` and `verifySubresourceIntegrity` (browser semantics:
  the strongest algorithm wins, compared in constant time).
- `nestvexa/assets`: `getManifest().integrity` maps every asset URL to SHA-384
  metadata of the exact served bytes. The umbrella's `browser: { integrity: true }`
  renders the boot module with `integrity` and `crossorigin`, plus
  integrity-checked `modulepreload` tags for the client, Alpine and the
  adapter. The option is rejected in manual mode and when it is not a boolean.
- Tests: `tests/vite-integrity.test.ts` (hash/verify, tags, algorithm/CDN
  base/explicit crossorigin, no change without integrity or in development,
  startup failures, and a real Chromium refusing a tampered entry).
  `tests/assets-integrity.test.ts` (metadata equals served bytes on
  Express/Fastify, boot tags, option validation, and Chromium starting intact
  assets but refusing a tampered Live client).
- Docs: `packages/vite/README.md`, `packages/nestvexa/README.md`,
  `docs/guides/client-assets.md`.
- Gap: there is no automatic integrity on dynamically imported chunks
  (Vite's preload helper does not add integrity). Only manifest-listed
  entries, styles and static preloads are covered.

### PROT-008: Live request boundary

- `429 RATE_LIMIT` now has a `Retry-After` header (seconds until the
  identity's window resets, 1–60). The body stays
  `{ statusCode: 429, code: 'RATE_LIMIT' }`.
- Tests: `tests/live-request-boundary.test.ts` on Express and Fastify:
  - 429 status, body shape, JSON content type and `Retry-After` range.
  - No secrets in the body, and the component is not executed.
  - `_sync` shares the budget; another identity keeps its own budget.
  - Non-POST methods (GET, HEAD, PUT, PATCH, DELETE) on action and `_sync`
    routes answer 404 without executing anything or sending protocol headers.
  - POST on the GET-only download route answers 404.
- Docs: `docs/reference/live-protocol.md` (error table).
- Gap: the full release attack corpus named in the ledger is not part of this
  round.

## Behavior changes to note

- Host `authorize` callbacks for Live and uploads must return a literal `true`;
  truthy non-boolean values now deny. This is noted in the changesets.
- `CoreModule` extensions with a `nestvexa` range that excludes
  `0.1.0-alpha.0` now fail startup.
