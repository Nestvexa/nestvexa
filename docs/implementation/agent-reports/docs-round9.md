# Documentation, round 9

Branch `r9-docs9`, from main `748681d`. Scope: the DOC and SEC rows of the
final ledger audit (`final-audit-b.json`) that are documentation gaps: DOC-002,
DOC-004 to DOC-016, DOC-018, DOC-020, DOC-022, DOC-036, DOC-037, DOC-041,
SEC-004 and SEC-031 (documentation parts only). No package source changed, so
no changeset is needed (the PR policy requires one only for `packages/*/src`).

## DOC-004: CI badge

**Done.** `README.md` shows the `ci.yml` status badge under the title. No
version badge: nothing is published, so a registry badge would show nothing
real.

## DOC-007, DOC-009 to DOC-012: verified quick starts

**Done.** Every TypeScript block in `README.md` is now a provenance excerpt
(`<!-- snippet: ... -->`) of an example that is compiled by its build and
exercised by a test, and a new docs-build rule fails if a README `ts`/`tsx`
fence is neither a provenance snippet nor a `ts check` block:

| Section         | Source                                                                                     | Test                                                          |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| MVC hello world | `examples/starter-hbs/src/main.ts` (`@Get() @Render('home')`, module, `configureNestvexa`) | `tests/browser/mvc.spec.ts`                                   |
| Live components | `examples/cli-generated` counter component, view, `liveActions` and the policy factory     | `tests/browser/cli-generated.spec.ts`                         |
| Live lifecycle  | one-paragraph hook order from `docs/guides/live-lifecycle.md` (DOC-009)                    | `tests/live-lifecycle-hooks.test.ts`                          |
| Inertia         | `examples/inertia-basic` controller and `createInertiaApp`                                 | `tests/browser/inertia.spec.ts`                               |
| Islands         | `examples/islands-vite` island definition and `renderSsr`, plus a DOM-ownership warning    | `tests/browser/islands-vite.spec.ts`                          |
| Server actions  | `examples/actions-basic` action group and typed client call; security defaults listed      | `tests/actions-http.test.ts`, `tests/browser/actions.spec.ts` |

The old placeholder Live snippet (`origin, resolveIdentity, authorize`) is gone.

## DOC-008, DOC-013, DOC-015, DOC-016: pointers, packages, CLI

**Done.**

- A topic table links forms, uploads, realtime, Inertia, Vite/SSR, islands,
  server actions, caching, deployment, security, testing and migration guides,
  plus the new recipes and troubleshooting pages (DOC-013).
- The packages table has Node (`engines`), Nest (peer range) and "Runs in"
  columns taken from each `package.json`, with a note that CI tests Node 22/24
  on Ubuntu and Windows, only Nest 12.2.0 is installed, and browser code is
  tested with Playwright Chromium, Firefox and WebKit without a minimum-version
  policy (DOC-015). The client row now states the real budgets from
  `scripts/size.mjs` (44 KiB entry, 60 KiB total) instead of "48 KiB".
- A CLI section lists every command from `nestvexa --help`, how `add` brings in
  engines, frameworks and optional packages, and links the CLI reference
  (DOC-016, DOC-008).

## DOC-014: tenant policy

**Done.** The README security model has a tenant bullet: server-resolved tenant
only, in every binding, or the kernel `resolveTenant` with `kernelIdentity`;
`examples/multi-tenant` and `tests/multi-tenant-isolation.test.ts` as evidence.
`docs/security/guide.md` "Tenant isolation" no longer claims there is no shared
tenant resolution and no cross-transport test (both exist:
`packages/core/src/context.ts`, `tests/kernel-transports.test.ts`).

## DOC-018, DOC-020: Verification and known limitations

**Done.** "Load tests have not been run" is removed. The Verification section
adds `api:check` and `test:coverage` and a table for `test:property`,
`test:mutation`, `load` and `bench` (all run by `nightly.yml`) with their docs.
"Known limitations" was rebuilt from the open rows of `final-audit-a/b/c.json`
and the package "Status and limits" sections, and no longer lists shipped
features (Inertia `shareOnce` and error pages, UI chart and fields, the offline
queue, load/fuzz/mutation testing, GraphQL coexistence). It now covers: release
status and the missing independent review; single Redis primary and
LIVE-007; process-local action idempotency, rate limits, locks and upload
tokens, and no shared cache store; browser runtime limits (teleports, shadow
DOM, iframes, Alpine 3.17.x, text-only `nv:stream`, no shared Live/Inertia
navigation); testing depth (adapters, islands and Alpine bridge not fuzzed,
mutation not gating, single-process load, unmeasured items, unprofiled
overhead, no slowloris test); accessibility (manual screen-reader pass not run);
compatibility (one tested version per peer); by-design items; docs hosting.

`docs/feature-matrix.md` was refreshed the same way: the intro, the Inertia and
API product rows, the forms, cache, UI, CLI and plugin rows, the core and
inertia package rows, and the documentation rows (snippets, recipes,
troubleshooting, Markdown lint).

## DOC-022: package READMEs

**Done** (commit `e1028d6`). All 30 `packages/*/README.md` have Security,
Performance and Compatibility sections; core, mail and observability gained an
Examples section. Stale statements fixed on the way: the client "48 KiB complete
bundle" and "no code splitting", the mail "no runnable example", the actions
GraphQL note (tested next to Live, not next to actions), the umbrella's
host-Alpine adoption line, an alpine heap-test path and the cache "no runtime
dependencies". Facts recorded in the sections: `engines` is `>=22` for core,
client, views and the engines and `^22.13.0 || ^24.0.0` elsewhere; the Redis
connections have no TLS; the OpenTelemetry bridge is tested with a stand-in
tracer only; `pnpm size:islands` runs in no workflow.

## DOC-036, DOC-037: recipes and troubleshooting

**Done** (commit `7117861`). `docs/recipes/` has an index and eight recipes:
auth, tenant scoping, file upload, realtime dashboard, job progress, an Inertia
React page with an isolated Live element, fragment caching and an offline-safe
form. Every code block is a provenance snippet of an example; each recipe names
its tests and has `> **Known gap:**` notes where something is missing (no
example wires `createOfflineQueue`, no shared Redis `CacheStore`, no shared
Live/Inertia navigation). `docs/troubleshooting/README.md` maps real error codes
and startup messages (Live error catalog, uploads, realtime, Alpine, CSP and
Trusted Types, deployment, repository tooling) to their fixes. Both are in
`apps/docs/nav.json` (new "Recipes" and "Troubleshooting" sections) and linked
from `README.md` and `docs/getting-started/README.md`.

## DOC-002, DOC-041: type-checked snippets and Markdown lint

**Done, except owner actions and screenshots.**

- `apps/docs/src/typecheck.mjs`: fences tagged `ts check` are compiled by
  `pnpm docs:build` as ES modules with the repository's strict options
  (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, legacy decorators)
  against the built packages; workspace specifiers resolve to their built
  `.d.ts` entry points (from `collectEntries`), the rest to the root
  `node_modules`. A fence cannot be both `ts check` and a provenance snippet.
  The root README rule above makes every README TypeScript fence verified.
- Three real blocks are now checked: the `ActionsModule.register` policy in
  `docs/guides/server-actions.md`, the `RedisLiveStore` namespacing example in
  `docs/guides/caching.md` and the server-timeout example in
  `docs/security/hardening.md`. Making the caching block checked exposed a real
  error in the old text: its `namespace` returned `tenant: string | undefined`,
  which does not compile against `RedisLiveNamespace`; the guide is fixed.
- Which fences are verified and which are illustrative is documented in
  `apps/docs/README.md` ("What the build checks", "Writing pages") and in an
  amendment to ADR 0027.
- `markdownlint-cli2` 0.24.2 (exact devDependency) runs as `pnpm lint:md`,
  chained into `pnpm lint` (so CI's lint step runs it). `.markdownlint-cli2.jsonc`
  turns off only MD013, MD033, MD041, MD038 and MD028, each with its reason;
  `docs/implementation/**` and generated/verbatim files are ignored. Real issues
  it found and that are fixed: a table row broken by unescaped pipes in
  `docs/guides/production-services.md`, fences without a language in three
  files, and a bare URL.
- Tests: `tests/docs-site.test.ts` (26 tests, all passing) adds the
  `codeBlocks` analysis, `isCheckedFence`, an accepted checked block, an
  accepted README provenance fence, and rejections for a type error (TS2322), an
  unresolvable import (TS2307), a checked provenance fence and an unverified
  README fence.

Remaining: hosting the site (owner action), screenshots/visual regression (not
in scope), external link checking, an Arabic/RTL quickstart; other guide fences
stay illustrative until they are converted.

## SEC-031, SEC-004 (documentation only)

**Done for the documents; the underlying test gaps remain.**

- `docs/security/threat-model.md`: marked **INTERNAL** in a callout; "Residual
  risks" rewritten against main: shared Redis stores exist (single primary, no
  Sentinel/Cluster/TLS), what is still process-local (action idempotency, rate
  limits, locks, upload tokens, download URLs), the browser runtime **is**
  fuzzed (`tests/property-client-runtime.test.ts`) but the adapters, island
  hydration and Alpine bridge are not, mutation not gating, single-process load,
  no slowloris test, the real-service runs that were executed (Redis 7,
  SeaweedFS, ClamAV, two replicas) and what was not (real AWS S3, independent
  review, screen-reader pass).
- `docs/security/security-design-review.md` "Release blockers": dated refresh
  note (still internal, not a new review); the fuzz/mutation row narrowed to the
  adapter gap and the non-gating score; the ASVS row now says chapter
  applicability is assessed and the requirement mapping is partial; new rows for
  process-local action state and the missing slowloris test; the real-service
  row moved to "no longer blockers" with its evidence.
- `docs/security/hardening.md` has a new "Slow clients and server timeouts"
  section: Node defaults, a `ts check` example setting `headersTimeout`,
  `requestTimeout` and `keepAliveTimeout`, and the fact that no slowloris test
  exists (SEC-004 asked for this to be documented).
- No independent review is claimed anywhere.

## DOC-019: project links

**Partly done.** The README "Project" line now links the release process,
versioning and deprecation policy and the CONTRIBUTING standards. The
documentation-site link still needs the owner to host the site.

## Also fixed

- `docs/getting-started/README.md`: the `make:resource` gap now says `memory` and
  `typeorm` are supported.
- `docs/tutorials/crud-app.md`: the stale "no Prisma, TypeORM or Drizzle
  examples" and "no pipe for `@ActionInput`" gap replaced by the real one (no
  generated edit/delete form).

## Commands run

- `pnpm install --frozen-lockfile`, `pnpm build`: passed.
- `node apps/docs/src/build.mjs --check-only` (what `pnpm docs:build` runs
  first): 287 documents, 79 provenance snippets, 3 type-checked blocks, passed.
- `pnpm exec vitest run tests/docs-site.test.ts`: 26 passed.
- `pnpm lint` (ESLint, boundaries, markdownlint), `pnpm exec tsc -p
tsconfig.tests.json --noEmit`, `pnpm format:check`: see the final message.

## For the coordinator

- `package.json` gains `markdownlint-cli2` (devDependency, 0.24.2) and the
  `lint:md` script; `lint` now ends with `&& pnpm lint:md`. The lockfile changes
  accordingly; expect a lockfile conflict with any branch that adds
  dependencies (resolve with `pnpm install`).
- `apps/docs/nav.json` gains two sections; `README.md`,
  `docs/feature-matrix.md` and several package READMEs were rewritten in places,
  so branches touching the same lines (for example `r8-dx8` if it edits the
  README or matrix) will conflict. No file under `docs/reference/` was changed.
- Ledger rows to update: DOC-004, DOC-007 to DOC-016, DOC-018, DOC-020,
  DOC-022, DOC-036 can move to Done; DOC-037 has only the extension-API
  stability note left; DOC-002 and DOC-041 keep the hosting owner action,
  screenshots and external link checks; SEC-031 keeps the partial ASVS
  requirement mapping (SEC-002); SEC-004 keeps the adapter fuzz, slowloris test
  and distributed load gaps.
