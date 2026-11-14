# Agent report: kernel round 5 (policies everywhere, kernel identity, feature registry)

Branch `r5-kernel5` (from main `928b2f1`). Packages: `@nestvexa/core`,
`@nestvexa/live`, `@nestvexa/uploads`, `@nestvexa/realtime`,
`@nestvexa/actions`, `@nestvexa/inertia`, `@nestvexa/observability`, `nestvexa`
(umbrella). New tests: `tests/kernel-registry.test.ts` (`test:unit`,
`test:security`) and `tests/kernel-transports.test.ts` (`test:integration`,
`test:security`; real Express **and** Fastify servers). Changesets:
`kernel5-core-registry.md`, `kernel5-transports-identity.md`,
`kernel5-actions-inertia-policies.md`, `kernel5-umbrella-features.md`. The
package graph is unchanged: no feature package imports `@nestvexa/core`; every
kernel touchpoint is a structural option (`policies`, `kernelIdentity`,
`featureRegistry`), and `scripts/boundaries.mjs` passes unchanged. ADR 0030 has
a second amendment.

## Per ledger row

### CORE-047: `SecurityPolicyRegistry` is the single source for every transport

- **Contract** (`packages/core/src/security.ts`, additive): `csrf.verify(request,
  subject?, token?)` and `action-authorization.authorize(subject, resource,
  action, request?)`; `SecurityPolicyRegistry.verifyCsrf(owner, request,
  subject?, token?)` and `authorize(owner, subject, resource, action, request?)`
  pass them through. Existing policies keep working.
- **Server actions** (`packages/actions/src/policies.ts`, `runtime.ts`,
  `options.ts`): new `policies`/`policyOwner` (default `actions`).
  `actionSecurityPolicies` is the one implementation (exact origin allowlist,
  constant-time CSRF header, host `authorize`). With a registry, actions
  register `origin`, `csrf` (only when `csrf.required` is not false) and
  `action-authorization` and ask the registry for every decision in the
  admission gate (action routes and `_jobs`). Registry resource is the group,
  action is `id` or `id/v<version>`, and the request is passed because the
  host `authorize` receives it (a decision without a request is denied).
- **Inertia** (`packages/inertia/src/security.ts`, `security-guard.ts`,
  `service.ts`, `options.ts`): new opt-in `security: { origin, csrfToken,
  authorize? }` plus `policies`/`policyOwner` (default `inertia`).
  `InertiaSecurityGuard` (exported and provided by `InertiaModule`; applied by
  the host with `@UseGuards` or `APP_GUARD`) checks `Origin` and `X-XSRF-TOKEN`
  (URL-decoded, constant time) on unsafe methods; every page render asks the
  authorization policy (resource: component, action `render`). Codes:
  `403 ORIGIN_REJECTED`, `CSRF_REJECTED`, `PAGE_FORBIDDEN`.
- **Uploads multipart form path** (`packages/uploads/src/service.ts`,
  `policies.ts`): the `_csrf` field is handed to the registered CSRF policy as
  `token` (through the registry when configured); file writes are queued
  behind the async decision, a missing field or a file before it is still
  `403 CSRF_REJECTED`. The direct comparison and its `equal` helper are gone.
- Tests (`tests/kernel-transports.test.ts`, Express and Fastify):
  - actions: `report()['actions']`; spies prove origin/CSRF/authorization
    are asked of the registry with owner `actions` (including `whoami/v2`);
    a registry that says no blocks each step (`ORIGIN`, `CSRF`, `POLICY`); the
    policies still reject a foreign origin and a wrong token on their own; a
    request-less registry decision is denied; the owner is reserved.
  - Inertia: `report()['inertia']`; missing/wrong token, foreign origin and a
    registry denial are refused before the handler runs; the registry is asked
    for `Dashboard`/`render`; `Secret` is `403 PAGE_FORBIDDEN`.
  - uploads form: the registry receives the field token; wrong token, another
    session's token, a missing field and a registry denial are refused, and
    no pending file leaks.
  - `tests/kernel-registry.test.ts`: the registry passes `token` and `request`
    through, and a policy that needs the request denies without one.
  - Regression: `tests/kernel-integration.test.ts` (Live and uploads through
    the registry) and `tests/actions-security.test.ts` (500 on a throwing host
    `authorize` without a registry) still pass.
- Docs: core README (`SecurityPolicyRegistry`), actions, inertia and uploads
  READMEs, ADR 0030 amendment, `docs/architecture/overview.md`.

### CORE-043 (kernel half of DATA-017): one user and tenant across transports

- **Kernel** (`packages/core/src/context.ts`): `RequestContextFactory.identity(request)`
  returns one frozen `{ authenticated, principal?, tenant? }` per request
  object, built only from `resolvePrincipal`/`resolveTenant` (resolver errors
  reject). The kernel never reads a tenant from the body, query or a header.
- **Transports** (opt-in `kernelIdentity`, structural `{ identity(request) }`;
  `kernel.ts` in each package): Live, server actions, uploads, realtime
  (`RealtimeService.identity`, used by SSE, polling and the WebSocket upgrade,
  and on every revalidation) and Inertia. Each still calls its own
  `resolveIdentity` for the session binding and CSRF secret, then attaches the
  kernel `principal` and `tenant` to the identity every host policy receives.
  Live, uploads and realtime scope their bindings to the principal and tenant
  (`nvk1.<sha256>`, identical function in the three packages), so snapshots,
  upload tokens and realtime subscriptions never cross users or tenants.
  Server actions reject a host `subject` that differs from the principal id
  or a host tenant that differs from the kernel tenant (`401
  IDENTITY_MISMATCH`); uploads reject a differing host tenant (`401
  IDENTITY_REQUIRED`). A failing or malformed kernel identity fails closed
  (`401`; Inertia `403`). Host values for `principal`/`tenant` are ignored.
- **Inertia shared props**: `nvIdentity` (`{ authenticated, tenant? }`, never
  the principal id or roles) on every page, winning over a shared prop of the
  same name. **MVC views** already expose `nvRequest.tenant`/`authenticated`
  from the same factory.
- **Umbrella**: `kernelIdentity: true` in the Live registration passes the
  factory to Live (opt-in, so existing bindings are unchanged).
- Tests (`tests/kernel-transports.test.ts`, Express and Fastify):
  - one session (alice/acme) with a forged `x-tenant-id`/`x-nestvexa-tenant`
    header: the MVC page shows `acme`, Inertia shares `{ authenticated: true,
    tenant: 'acme' }` without the user id, the server action context reports
    `alice`/`acme`, and the recorded host decisions of Live, Inertia,
    actions, uploads and realtime are exactly `alice:acme`; bob cannot use
    alice's realtime token and cannot get one for `tenant:acme`.
  - revoking alice's role in the server-side store denies the next Live
    action, server action, upload, realtime connection and Inertia page
    (nothing executes); a session tenant switch invalidates the Live
    snapshot and switching back restores it; host impersonation and a host
    tenant header are rejected; anonymous requests are refused.
  - `tests/kernel-registry.test.ts`: `identity()` is frozen, shared per
    request, ignores client headers/body, and fails closed.
- Docs: core README ("One user and tenant across transports"), umbrella,
  live, actions, uploads, realtime and inertia READMEs, ADR 0030 amendment.
- Gaps:
  - Islands have no server transport of their own (they call server actions
    or read Inertia props), so they are covered only through those.
  - The umbrella wires Live only; hosts pass `kernelIdentity` to actions,
    uploads, realtime and Inertia (`registerAsync`/`forRootAsync` with
    `inject: [RequestContextFactory]`), because the umbrella does not own
    those modules.
  - The example-level ORM, auth-starter and tenant-isolation examples are the
    `r5-data-orm-auth` branch's job; this branch adds only the test fixture.
  - CSRF tokens remain host-issued per transport (`resolveIdentity`); the
    kernel does not mint them.

### CORE-039 / CORE-046: `NestvexaRegistry` and feature capabilities

- **Kernel** (`packages/core/src/features.ts`): `NestvexaRegistry` (provided
  and exported by `CoreModule`) with `registerFeature({ name, package,
  version?, components?, actions?, views?, renderers?, capabilities? })`,
  `features()`, `components()`, `actions()`, `views()`, `renderers()`,
  `plugins()` (installed extensions, via the new
  `NestvexaExtensionHost.describe()`), `require(name)` and `report()` (frozen
  data). Unknown fields, malformed names, duplicate entries or features and
  late registrations are rejected; it seals on application bootstrap. Each
  capability is declared in `FeatureCapabilityRegistry` as
  `<feature>.<capability>`.
- **Feature packages** register through a structural `featureRegistry`
  option while they are instantiated: Live (`live`: components, views,
  `state-store`, `realtime`, `kernel-identity`), server actions (`actions`:
  every `group/id`, `idempotency`, `jobs`, `csrf`, `kernel-identity`),
  uploads (`uploads`: `storage`, `direct`, `scan`, `kernel-identity`),
  realtime (`realtime`: `broker`, `websocket`, `sse`, `polling`, `presence`,
  `kernel-identity`) and Inertia (`inertia`: `ssr`, `session`, `security`,
  `kernel-identity`). Degraded entries say why (for example a process-local
  store). The umbrella registers Live and the shared HBS renderer (`views`,
  renderer `hbs`, `views.hbs.<capability>`).
- **Devtools** (`packages/observability/src/devtools.ts`): `kernel.features`
  (`NestvexaRegistry`) adds `kernel.features`/`kernel.plugins` to
  `data.json` and a Features section to the panel.
- Tests: `tests/kernel-registry.test.ts` (listing, qualified capabilities,
  frozen data-only report, validation and duplicate/late rejection, plugins
  and sealing inside a real Nest app); `tests/kernel-transports.test.ts`
  (all six features registered in one app, components/actions/renderers,
  capabilities such as `live.kernel-identity`, `uploads.scan`,
  `realtime.broker` (degraded), `views.hbs.streaming`, and the devtools
  `data.json` and panel).
- Docs: core README (`NestvexaRegistry`), umbrella and observability READMEs,
  `docs/guides/observability.md`, ADR 0030 amendment.
- Gaps: view engines added with `registerViewEngine` are not listed; other
  optional packages (islands, forms, cache, i18n, ...) do not register
  themselves yet.

## Behaviour changes and migration notes

- Without the new options nothing changes, with two exceptions documented in
  the changesets:
  - the umbrella now declares `live.*` and `views.hbs.*` capabilities, so an
    extension declaring a capability with one of those names fails startup
    with `DUPLICATE_REGISTRATION`;
  - the uploads form CSRF decision is now made by the registered policy
    (same accept/reject results; with `policies` the registry decides).
- With `policies`, a throwing host `authorize` in server actions is a `403
  POLICY` denial (the registry fails closed) instead of a 500.
- With `kernelIdentity`, Live/uploads/realtime bindings are scoped. Enable it
  on Live and realtime together when Live signs realtime tokens;
  `RealtimeService.revoke(binding)` then takes the scoped binding.

## Verification

RESULTS_PLACEHOLDER
