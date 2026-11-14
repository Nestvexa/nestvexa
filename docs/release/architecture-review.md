# Architecture review questions (spec section 28)

Answered 2026-11-14 on branch `r6-release` (main `bb1527b`). Each question
cites the code and tests that answer it. Section 28 requires that any "No",
"Partly", unknown or untested answer on a critical requirement becomes a
tracked issue before release. Those issues are listed under each answer and
in the ledger rows `REVIEW-003`…`REVIEW-022`.

This document is an internal engineering record, **not an independent
security review**. Paths are relative to the repository root.

| Ledger     | Question (short)                                       | Answer  |
| ---------- | ------------------------------------------------------ | ------- |
| REVIEW-003 | Decorators have runtime behavior?                      | Partly  |
| REVIEW-004 | Live actions run through Nest DI/auth pipeline?        | Yes     |
| REVIEW-005 | Two users/tenants, same component id, no leak?         | Yes     |
| REVIEW-006 | Browser-crafted paths, prototypes, names, templates?   | Refused |
| REVIEW-007 | Snapshot tokens canonical, bound, expiring, revocable? | Yes     |
| REVIEW-008 | Snapshot leaks services/session data?                  | Partly  |
| REVIEW-009 | CSRF with real cookie auth?                            | Yes     |
| REVIEW-010 | Engine escaping bypass via interpolation/helpers?      | No      |
| REVIEW-011 | Inertia page JSON injection-safe and exact v3?         | Partly  |
| REVIEW-012 | Deferred/optional/once props really deferred?          | Yes     |
| REVIEW-013 | Three framework islands coexist?                       | Yes     |
| REVIEW-014 | Morph keeps input, focus, Alpine state; removal?       | Yes     |
| REVIEW-015 | Typed actions from every adapter in packed apps?       | Partly  |
| REVIEW-016 | Duplicate irreversible effects possible?               | Partly  |
| REVIEW-017 | Redis/cache/jobs/channels isolate and reconnect?       | Partly  |
| REVIEW-018 | Default install lightweight?                           | Yes\*   |
| REVIEW-019 | Pack includes bins/assets/types, excludes repo files?  | Partly  |
| REVIEW-020 | READMEs work from scratch externally?                  | Partly  |
| REVIEW-021 | Performance claims against honest baselines?           | No      |
| REVIEW-022 | Docs distinguish stable/experimental/optional/future?  | Partly  |

## REVIEW-003: decorators with runtime behavior

Every exported decorator is used by at least one behavior test:

- Live: `packages/live/src/metadata.ts` and `state-context.ts`.
- Actions: `packages/actions/src/metadata.ts`.
- Inertia: `packages/inertia/src/decorators.ts`.
- `RouteName`: `packages/core/src/routes.ts`.
- `RequireFlag`: `packages/flags/src/nest.ts`.

Some of those tests are `tests/live-optional-decorators.test.ts`,
`tests/live-state-context.test.ts`, `tests/core-routes.test.ts`,
`tests/flags-nest.test.ts` and `tests/inertia-http.test.ts`.

**Issue:** no test enumerates the exported decorators and checks that each
one has a runtime effect. `Locked`, `Modelable`, `UseInertia`, `Title`,
`Renderless`, `Validate`, `RouteName` and `RequireFlag` are each exercised by
only one test file.

## REVIEW-004: Nest request-scoped DI and auth pipeline

Yes. The implementation is in `packages/live/src/runtime.ts`,
`packages/live/src/live.module.ts`, `packages/actions/src/runtime.ts` and
`packages/actions/src/enhancers.ts`. The tests:

- `tests/live-pipeline.test.ts` ("runs middleware, guards, host authorization,
  interceptors and pipes before the action in Nest order"; per-request
  providers; filters).
- `tests/live.test.ts`
- `tests/live-instance-scope.test.ts`
- `tests/actions-http.test.ts` (global, class and method guard denial)

**By design** (`docs/adr/0003-nest-execution-pipeline.md`): Live model
synchronization (`_sync`) runs only the global and class enhancers.
**Issue:** non-HTTP transports (GraphQL, microservices, WebSocket gateways)
are not wired or tested.

## REVIEW-005: two users or tenants on one component identifier

No leak. The state store binds every record to tenant, session and principal
with a SHA-256 binding that is compared in constant time
(`packages/live/src/store.ts`, `packages/realtime-redis/src/live-store.ts`).
The tests:

- `tests/live-instance-scope.test.ts` ("isolates cookie-authenticated fixture
  identities and never resolves a forged cross-user snapshot")
- `tests/live-state-context-integration.test.ts`
- `tests/live-store-contract.test.ts`
- `tests/browser/multi-tenant.spec.ts`
- `tests/services/distributed.spec.ts`

`MemoryLiveStore` is per process; multi-replica deployments use the Redis
store.

## REVIEW-006: crafted paths, prototypes, names, templates and methods

All are refused. The implementation is in `packages/live/src/protocol.ts`,
`packages/live/src/writable-paths.ts` and `packages/live/src/runtime.ts`. The
tests:

- `tests/property-live-protocol.test.ts` (prototype keys at any depth)
- `tests/live-writable-paths.test.ts`
- `tests/live-admission.test.ts` (only declared actions)
- `tests/live-instance-scope.test.ts` (unregistered component)
- `tests/security.test.ts` and `tests/property-view-paths.test.ts`
  (template traversal)
- `tests/forms-progressive.test.ts` (prototype pollution)

## REVIEW-007: snapshot tokens and replay

Live does **not** sign state. The browser holds an opaque random 32-byte
token, and the state stays on the server. Tokens are canonical, bound to an
identity, expire (`ttlMs`) and can be revoked. A revision lock rejects old
state before any effect runs. The tests:

- `tests/property-live-protocol.test.ts` (canonical base64url)
- `tests/live-protocol.test.ts` (stale replay, revoke/delete/clear/expire)
- `tests/live.test.ts` (logout invalidation, 409/410)
- `tests/live-store-contract.test.ts` (replay, encryption at rest, downgrade)

Island props are signed (`tests/islands.test.ts`). The host must call
`revoke(binding)` on logout, and the guides document this.

## REVIEW-008: sensitive data in browser state

The browser receives only public `@State` fields and the token. Bindings and
services are never sent. The tests:

- `tests/live.test.ts` (provider secret absent)
- `tests/live-store-contract.test.ts` (no raw tokens or bindings stored)
- `tests/live-state-context.test.ts`
- `tests/islands.test.ts` (closed props schema, secret-like keys refused)

**Issue:** Live has no secret-like key check for `@State` names, unlike
islands. Anything declared `@State` is public by contract.

## REVIEW-009: CSRF with real cookie authentication

Yes. `packages/live/src/security-policies.ts` checks the exact Origin and
compares the `x-nestvexa-csrf` header with the identity's token in constant
time. The tests:

- `tests/browser/actions.spec.ts` (real cookie sign-in; a same-origin fetch
  without the token is refused)
- `tests/actions-http.test.ts`
- `tests/inertia-security.test.ts` (express-session XSRF cookies)
- `tests/forms-progressive.test.ts`
- `tests/cors-posture.test.ts`

## REVIEW-010: template escaping bypass

No bypass through untrusted interpolation or custom helpers. The tests are
`tests/views.test.ts` (HBS), `tests/engine-ejs.test.ts`,
`tests/engine-pug.test.ts`, `tests/engine-nunjucks.test.ts`,
`tests/custom-engine.test.ts` and `tests/browser/alpine-injection.spec.ts`.
They cover script-closing sequences, attribute breakouts, isolated helpers
whose output is escaped, and hostile `toHTML`.

The documented raw forms (`{{{ }}}`, `<%-`, `!=`, `|safe`) and helpers that
return `SafeHtml` are explicit opt-ins.

## REVIEW-011: Inertia page JSON

Script-closing injection is prevented. The tests are
`tests/inertia-security.test.ts`, `tests/inertia-protocol.test.ts` and
`tests/property-inertia.test.ts`. The protocol is pinned by 22 golden fixtures
(`tests/inertia-golden.test.ts`, `tests/fixtures/inertia/`).

**Issues:** the fixtures were written by hand from the v3 docs and
`@inertiajs/core` 3.10.0; they were not captured from a reference server.
Inertia 3.11.0 is untested (`docs/architecture/upstream-compatibility.md`).

## REVIEW-012: deferred, optional and once props

Yes, they are deferred. `tests/inertia-http.test.ts` counts how often each
prop callback runs: "evaluates regular props, never optional or deferred
props, on a full visit". It also covers partial reloads and once props. The
golden fixtures 04, 07 and 08 cover the same cases.

## REVIEW-013: three framework islands

Yes. The tests are `tests/browser/islands.spec.ts` (independent mount,
exactly one remount, per-framework hydration mismatch reports),
`tests/browser/islands-vite.spec.ts`, `tests/browser/inertia-mixed.spec.ts`
and `tests/islands-client.test.ts`.

## REVIEW-014: morphing, focus and Alpine state

Yes. The tests:

- `tests/browser/live.spec.ts`
- `tests/browser/phase3-board.spec.ts` (keyed rows, Alpine state, local input)
- `tests/browser/models.spec.ts`
- `tests/browser/focus.spec.ts`
- `tests/client-runtime-resilience.test.ts` (caret and selection)
- `tests/live-nesting.test.ts` (removed children are revoked)
- `tests/browser/replacement-loading.spec.ts` (Alpine subtree disposal)

## REVIEW-015: typed actions from packed external apps

Partly. `pnpm test:pack` (`tests/pack-consumers/consumer.ts`,
`bindings-check.ts`) generates Live, React, Vue and Svelte bindings from the
tarballs and type-checks them. The Vue composables and Svelte stores call
the packed server.

**Issues:** the React hooks are only rendered with `renderToString` and never
call the server. No Inertia-adapter consumer exists.

## REVIEW-016: duplicate irreversible effects

Partly. These are tested:

- idempotency replay and concurrent duplicates (`tests/actions-http.test.ts`)
- the Live run-once fence (`tests/live-store-contract.test.ts`)
- shutdown drain (`tests/live-action-options.test.ts`)
- job recovery (`tests/realtime-job-queue.test.ts`)
- offline replay at most once (`tests/offline-queue-server.test.ts`)

**Issue:** server-action idempotency records live only in process memory
(`MemoryIdempotencyStore`). A restart or a second replica can run a retried
action twice. Upload tokens are also process-local.

## REVIEW-017: Redis, cache tags, jobs and tenant channels

Partly. These are tested:

- resubscription after a drop (`tests/realtime.test.ts`)
- tenant isolation (`tests/realtime-hub.test.ts`)
- reconnect without duplicates (`tests/services/distributed.spec.ts`)
- cache keys per tenant (`tests/cache-poisoning.test.ts`)

**Issues:**

- `@nestvexa/cache` has no Redis store, so tags work inside one process only.
- Only a single Redis primary is supported; Sentinel and Cluster are not.
- Client backoff/jitter and WebSocket cursor replay are untested (REAL rows).

## REVIEW-018: default install

Yes, but no test enforces it (marked \*). `packages/nestvexa/package.json`
depends on core, views, engine-hbs, live, client, alpine and `@alpinejs/csp`.
Its peers are Nest, `reflect-metadata` and `rxjs`. There is no SPA framework,
S3, Redis or ORM, and the minimal pack consumer installs only the umbrella.

**Issue:** `scripts/boundaries.mjs` only blocks the other engines. Nothing
fails if the umbrella gains a framework, Redis, S3 or ORM dependency.

## REVIEW-019: tarball contents

Partly. `scripts/pack.mjs` requires the README, LICENSE, `dist/index.js` and
`.d.ts`, the string export targets and the Svelte sources. Since this round
it also requires every `bin` target and secret-scans every packed file. It
refuses `src/`, `tests/`, `node_modules/` and `.env`.

**Issues:** the `.d.ts` of each conditional subpath export is not checked one
by one, and there is no vitest test of `pack.mjs`.

## REVIEW-020: READMEs from scratch

Partly. `tests/docs-site.test.ts` compares the docs snippets with the example
sources.

**Issues:** the examples use `workspace:*`, and package README snippets are
not tested. No package is published (`npm view nestvexa` returned 404 on
2026-11-14), so README install commands only work from local tarballs.

## REVIEW-021: performance baselines

No improvement is claimed, and none is measured against a baseline.
`scripts/bench.mjs` measures the cached HBS adapter only. `scripts/load.mjs`
enforces absolute budgets, which are not comparisons.

**Issue:** a plain-Nest baseline on equivalent hardware is open
(ADR 0010).

## REVIEW-022: feature status labels

Partly. `docs/feature-matrix.md` labels features Shipped (alpha), Partial,
Missing or By design. Every package README has a "Status and limits"
section, and known gaps use `> **Known gap:**`.

**Issues:** there are no separate experimental, optional, unsupported or
future labels. No test checks that a stated status matches the code.
