# Agent report: islands and universal server actions

Branch: `worktree-agent-a513e8601057f3384`. Ledger groups ISLAND and ACT.
Packages: `@nestvexa/islands`, `@nestvexa/actions`; examples
`examples/hybrid-dashboard`, `examples/actions-basic`. Test commands and
results are listed at the end. Proposed states are suggestions for the
coordinator; evidence is the named test files.

## ISLAND

### ISLAND-004 (manifest, bundle path, props, strategies, SSR HTML, hydration state) - proposed Done

- Build-time manifest: `packages/islands/src/build.ts` (`createIslandManifest`
  from an esbuild-style metafile: id, framework, strategy, bundle path,
  `maxPropsBytes`, closed props schema, `signed`, `budgetBytes`);
  `packages/islands/src/shared.ts` (`parseIslandManifest`, safe bundle path
  pattern, props schema checker). Consumed by `IslandRegistry.fromManifest`
  (server) and `createIslands({ manifest })` (browser: ids, framework match,
  byte limit, schema, loads from the manifest `bundle` path only).
- SSR + hydration state: `IslandRegistry.renderSsr` + `react-server.ts`,
  `vue-server.ts`, `svelte-server.ts`; roots get `data-nv-ssr` and the same props
  in `data-nv-props`. Vue (`createSSRApp`) and Svelte (`hydrate`) adapters now
  hydrate; React already did.
- `interaction` strategy tested (pointer/hover and keyboard focus, mounts once).
- Tests: `tests/islands.test.ts` (manifest build/parse, unsafe bundle paths,
  SSR success/fallback), `tests/islands-client.test.ts` (manifest enforcement,
  interaction strategy), `tests/islands-bundle.test.ts` (SSR of React/Vue/Svelte
  from the example SSR bundle), `tests/browser/islands.spec.ts` (clean hydration
  of React, Vue and Svelte SSR islands).

### ISLAND-006 (build-time registry; never import client-requested modules) - proposed Done

- `tests/islands-client.test.ts` "refuses ids outside the build-time allowlist
  without loading anything": unknown, `../../etc/passwd` and `constructor` ids are
  refused, the allowlisted loader alone runs, roots keep their fallback. "enforces
  the manifest": the only imported URL is the manifest path; a `data-nv-bundle`
  attribute in markup is ignored; manifests with absolute/scheme-relative/`..`/
  non-JS bundle paths are rejected.

### ISLAND-007 (strict props, size limits, signed props, no secret leakage) - proposed Done

- Signed props: `signed: true` + `signingKeys` (>= 32 bytes, rotation),
  `data-nv-props-token` (HMAC-SHA256 over id, iat, exp and exact props JSON),
  `verifyProps` rejects changed props, foreign island, forged/extended expiry and
  expired tokens. Tests: `tests/islands.test.ts` "signs props and rejects
  tampered, foreign, expired and unsigned tokens"; browser: tampered widget props
  sent to `dashboard.set-status` get `400 VALIDATION` (`tests/browser/islands.spec.ts`).
- Secret non-leakage enforced in code: secret-like prop keys rejected unless
  `allowSensitiveKeys`; closed schemas reject undeclared fields (e.g. an entity
  with `customer.email`); same checks apply to `renderSsr` and in the browser
  loader against the manifest schema/limit. Tests: `tests/islands.test.ts`,
  `tests/islands-client.test.ts`, `tests/islands-bundle.test.ts`.

### ISLAND-009 (theme/design tokens, user-safe context, transport client, typed actions; server-side checks) - proposed Done

- `IslandRegistry.contextScript` (validated locale, direction, design tokens,
  display-only user fields; script-safe JSON) and loader `context`/
  `#nv-islands-context` -> `island.shared`; tokens applied as `--nv-<name>` custom
  properties, `dir`/`lang` set. Typed `services` (`createIslands<Services>`) carry
  the generated actions client (transport + typed action interface).
- Hybrid example islands call typed actions: React hook
  (`useDashboardRecordEvent`), Vue composable, Svelte store, and a job action;
  server checks via `ActionsModule` host `authorize` + session identity.
- Tests: `tests/islands.test.ts` (context validation/escaping),
  `tests/islands-client.test.ts` (theme tokens, context, services, signed props,
  unsafe context rejected), `tests/browser/islands.spec.ts` ("islands call typed
  server actions", "hydrate cleanly with shared theme tokens", anonymous call 401).

### ISLAND-010 (event bridge lifecycle, payload validation, no leaks) - proposed Done

- `on(name, handler, accept?)` predicate validation (rejections counted),
  remover function, configurable `maxListeners` (default 32), listener removal on
  unmount, `diagnostics()` listener counts.
- Test: `tests/islands-client.test.ts` "caps listeners, validates names and
  payloads, clones details and cleans up on unmount" (cap error, invalid names on
  `on` and `emit`, `DataCloneError` for functions, mutation after emit not
  visible, predicate rejection counted, zero listeners and no delivery after
  removal). Example feed uses a predicate.

### ISLAND-011 (fallback, noscript, accessibility, hydration mismatch reporting) - proposed Done

- `noscript` render option (sibling `<noscript data-nv-island-noscript>`,
  escaped unless `SafeHtml`), also via `nvIsland` helper. `aria-busy` while
  loading.
- Mismatch reporting: `context.reportMismatch`, loader `onHydrationMismatch`
  (bounded to 10), `data-nv-hydration-mismatch`, `diagnostics().hydration`.
  React via `onRecoverableError`; Vue/Svelte by DOM comparison around the
  synchronous hydration pass.
- Tests: `tests/islands.test.ts` (noscript), `tests/islands-client.test.ts`
  (mismatch reporting only for SSR roots, bounded), `tests/browser/islands.spec.ts`
  ("hydration mismatches are reported per framework" on `/hybrid/diagnostics`,
  "without JavaScript, SSR markup, fallbacks and noscript content remain", axe).
- Known gap: Vue attribute-only mismatches are not repaired by Vue in
  production and therefore not detected (documented). With Playwright's
  `javaScriptEnabled: false`, Chromium does not render `<noscript>` contents, so
  the e2e asserts the element and text are served rather than displayed.

### ISLAND-012 (performance budgets, deferred strategies) - proposed Done

- `analyzeIslandBundles` (per-island chunk closure, gzip sizes, framework
  runtimes, budget violations); `scripts/islands-size.mjs` (`pnpm size:islands`,
  writes `artifacts/reports/islands-size.json`, exit 1 on violation); the example
  build fails on violations.
- Measured (hybrid build): revenue-chart 71,640 / 80,000; react-kpi 69,900 /
  80,000; activity-feed 26,795 / 45,000; status-widget 20,471 / 30,000;
  broken-island 488 / 2,000 gzip bytes.
- Strategies: `interaction` tested directly; `immediate`, `visible` and `idle`
  exercised in the example and browser spec.
- Tests: `tests/islands-bundle.test.ts`, `tests/islands-client.test.ts`.

### ISLAND-014 (coexistence, navigation, unmount race, bundle analyzer) - proposed Done

- Navigation: `/hybrid` <-> `/hybrid/about` via `nv:navigate`; islands unmount on
  the body swap and remount once on return; `pagehide` cleanup for full loads.
- Unmount race: unit (chunk still loading; async mount in flight) and browser
  (vue chunk held via `page.route` while navigating away: never mounts, mounted
  count 0, mounts once after returning).
- Bundle analyzer evidence: `dist/public/islands-analysis.json`; chunk list per
  framework from the last build: react `chunks/chunk-3PEHZYA6.js`, vue
  `chunks/chunk-L6J2AL7P.js`, svelte `chunks/chunk-IRH4AMOM.js` (hashes change per
  build); each island's closure contains only its own framework runtime; the two
  React islands share one React chunk.
- Tests: `tests/browser/islands.spec.ts` ("navigation cleans up islands and wins
  the race against a loading chunk", existing Live retention/reinsertion/
  duplicate-mount tests), `tests/islands-client.test.ts` (races, pagehide),
  `tests/islands-bundle.test.ts` (separation assertions from the metafile).

### ISLAND-001, ISLAND-003, ISLAND-013 (headings)

All child rows above are addressed; proposed Done once the coordinator accepts
the children.

## ACT

### ACT-008 (streaming handle/job ticket, accepted async job) - proposed Done

- `@ServerAction({ job: true })` + `acceptJob(name, handler)`; route answers 202
  with `{ data: null, job: { id, status, progress, pollAfterMs, stream? } }`;
  `<prefix>/_jobs/status` and `/_jobs/cancel` (same admission, host `authorize`
  with group `_jobs`, owner-bound queue). Queue is the structural
  `ActionJobQueue`; `@nestvexa/realtime`'s `JobRunner` satisfies it (no package
  dependency); `jobs.channel` provides the streaming handle, `jobs.owner` aligns
  owner binding with the realtime identity. Idempotent job actions replay the
  same ticket. Client: `ActionJobHandle` (`status`, `wait` with progress,
  `cancel`, `stream`), `client.job(id)`.
- Files: `packages/actions/src/jobs.ts`, `runtime.ts`, `module.ts`,
  `metadata.ts`, `options.ts`, `shared/protocol.ts`, `client/index.ts`.
- Tests: `tests/actions-jobs.test.ts` (Express and Fastify: 202, progress,
  result, foreign identity 404, `JobRunner.authorize` channel check, cancel,
  idempotent replay, generic failure message, contract errors, missing queue 503;
  typed client handle; structural compatibility), `tests/browser/islands.spec.ts`
  (export report with progress).

### ACT-012 (request ids, structured logs, tracing, input redaction) - proposed Done

- `instrumentation` and `logger` host options (structurally the
  `@nestvexa/observability` interfaces). One `nestvexa.action` span and one
  `ActionCallLog` record per call, ended from the response `finish`/`close`
  event so guard/admission/host-filter rejections are covered; 499/CLIENT_CLOSED
  for disconnects. Redaction by construction (no inputs, outputs, identities,
  headers or error messages); telemetry exceptions never affect responses.
- Tests: `tests/actions-jobs.test.ts` "action tracing and structured logs"
  (span attributes and statuses 200/500/403, info/error/warn levels, secrets
  absent from spans and logs, host error mode, throwing telemetry, option
  validation); example exposes `GET /api/action-spans` asserted in the browser
  spec.

### ACT-014 (codegen targets, validation-error unions, optimistic types) - proposed Done

- Generator emits `ActionMethod<Input, Output, Field>` (top-level input field
  union), per-action `Input`/`Output`/`Error` (`ActionFailure<Field>`)/
  `Optimistic` aliases, `ActionJobHandle<T>` for job actions, and `targets`
  (`react` hooks, `vue` composables, `svelte` stores, `live` element helpers;
  CLI `--targets`). Declarations import only `@nestvexa/actions/client`.
  Client: `createActionController` (pending/error, optimistic with rollback,
  cancellation of superseded calls, Svelte store contract), `settle`,
  `bindActionElement`, `ActionBinding`/`ActionRefBinding` types.
- Tests: `tests/actions-codegen.test.ts` "emits typed framework targets,
  validation unions, optimistic types and job handles" (file set, typecheck of a
  correct consumer and of a consumer with 7 expected errors, runtime of the
  generated Svelte stores with optimistic rollback), updated deterministic-output
  assertions; `tests/actions-client-state.test.ts` (controller, settle,
  element binding in Chromium); browser: React/Vue/Svelte bindings in
  `tests/browser/islands.spec.ts`, Live helper in `tests/browser/actions.spec.ts`.
- Not re-run: `tests/pack-consumers/consumer.ts` via `pnpm test:pack` (packed
  outside the monorepo); the new targets use only package exports.

### ACT-016 (negative tests) - proposed Done

- `tests/actions-security.test.ts`: expired and tampered bearer tokens (401,
  never reaching guards/handler), forged claims, signed but unauthorized
  principal (403); expired idempotency record re-executes, key reuse with other
  input 409, malformed/missing keys; `authorize` returning truthy non-`true`
  values (1, 'yes', {}, [], undefined, null, false) -> 403 and a throwing policy
  -> 500 without leaking the message (behavior change: only a literal `true`
  admits); group registered without any guard protected by host policy only,
  registration without `authorize` impossible, anonymous 401, unknown action 404.
- Unauthorized subscriptions: job status/cancel for another identity 404 and
  `JobRunner.authorize` refusing the other owner's channel
  (`tests/actions-jobs.test.ts`).

### ACT-001, ACT-003, ACT-013, ACT-015 (headings)

Children ACT-008, 012, 014 and 016 addressed; proposed Done.

## Test commands run (Windows host)

- `pnpm exec vitest run` on: actions-http, actions-runtime, actions-client,
  actions-metadata, actions-codegen, actions-jobs, actions-security,
  actions-client-state, islands, islands-client, islands-bundle (results in the
  final message).
- `pnpm exec playwright test -c playwright.local.config.ts tests/browser/islands.spec.ts tests/browser/actions.spec.ts`
  on ports 3280/3281 (chromium, firefox, webkit; results in the final message).
- `pnpm lint` (eslint on touched paths + `node scripts/boundaries.mjs`),
  `pnpm exec tsc -p tsconfig.tests.json --noEmit`, example `tsc -p tsconfig.client.json`,
  `node scripts/islands-size.mjs`.

## Coordinator notes

- Root `package.json`: new tests added to `test:unit` (actions-client-state),
  `test:integration` (actions-jobs, islands-client, islands-bundle) and
  `test:security` (actions-security, islands, islands-client); new script
  `size:islands`.
- `tests/islands-bundle.test.ts` needs the hybrid example built (`pnpm build`).
- Browser specs read `NESTVEXA_HYBRID_URL` / `NESTVEXA_ACTIONS_URL` and default
  to the root config ports 3112/3111; the root `playwright.config.ts` needs no
  change. The hybrid example's start now takes longer (SSR bundle import); if
  the root config times out, raise that webServer `timeout`.
- Example dependencies added: hybrid-dashboard -> `@nestvexa/actions`,
  `@nestvexa/observability`, `@nestvexa/realtime` (workspace); lockfile updated.
- `.gitignore`: `examples/hybrid-dashboard/client/generated/`.
- Changesets: `.changeset/actions-jobs-telemetry-bindings.md`,
  `.changeset/islands-manifest-ssr-signing.md` (minor).
