# Agent report: distributed realtime and Live state (REAL, DATA)

Branch `worktree-agent-a6238a8529f3c69c6`. Design record:
[ADR 0027](../../adr/0027-distributed-state-and-redis.md). Real-service evidence:
`NESTVEXA_REDIS_PORT=6390 NESTVEXA_REDIS_CONTAINER=nv-agent-redis node scripts/services-check.mjs`
against `redis:7-alpine` (Docker Desktop 29.1.3) on 2026-11-05 — see
"Verification" at the end.

## DATA-005 — Pluggable custom state store interface with lock/concurrency semantics

**Implemented.** `LiveStateStore` interface in `packages/live/src/store.ts`
(`create`, `peek`, `transaction`, `revoke`, `delete`, `close`; sync or async) with
documented identity-binding, revision compare-and-set, single-transaction
(`COMPONENT_BUSY`), invalidate-on-failure, TTL and no-resurrection semantics.
`LiveRuntime` awaits every store call (`packages/live/src/runtime.ts`); the runtime
factory accepts any structurally valid store (`isLiveStateStore`,
`packages/live/src/live.module.ts`) instead of requiring `MemoryLiveStore`, which
stays the default. Shutdown calls `store.close()` (memory: discard; shared: close
connections). A non-protocol store error while retaining a nested child now
surfaces instead of silently remounting. Implementer helpers exported
(`liveStateUnavailable`, `liveBindingHash`, `freezeStateSnapshot`,
`freezeChildReferences`, `assertLiveComponentName`, `freezeJson`, `isSnapshotToken`).

- Tests: `tests/live-store-contract.test.ts` — one contract suite run against
  `MemoryLiveStore` and `RedisLiveStore` (12 cases each: binding, malformed/foreign
  tokens, invalid state, revision CAS and replay, busy, callback failure, oversized
  HTML, revoke/delete/expiry during a transaction, TTL, revoke isolation across
  users/tenants, child references, capacity, replica sharing) plus a
  two-Nest-application runtime test (mount on A, action on B, replay 409, foreign
  identity 410, A shut down keeps shared state). Existing Live suites updated to
  read the default store through `tests/support/memory-store.ts` (11 files, 301
  tests pass).
- Docs: `packages/live/README.md` (State stores), `docs/guides/live-protocol.md`,
  ADR 0027.
- Gap: none known for the interface. The contract suite is a test file, not a
  published helper package.

## DATA-004 — Redis-backed state (namespaced keys, TTL, safe serialization, encryption if required, CAS)

**Implemented** in the new optional package `@nestvexa/realtime-redis`
(`packages/realtime-redis/src/live-store.ts`, `resp.ts`): `RedisLiveStore` over a
zero-dependency RESP2 connection. Keys are SHA-256 hashes of the snapshot token
(`<prefix>s:`/`l:`) and of the binding (`<prefix>b:` per-identity index, the
tenant/user namespace used by `revoke` and the per-binding cap); raw tokens and
bindings never reach Redis. TTL via `PX` plus stored `expiresAt`; transaction lease
via `SET NX PX`; commits via `WATCH`/`MULTI`/`EXEC` compare-and-set on lease owner,
id and revision; `create` and `revoke` are atomic with the index (revoke retries
under `WATCH`). Records are versioned JSON validated on read with `cloneState`
limits (prototype keys, non-JSON, size). Optional AES-256-GCM at rest with key
rotation, key-name AAD and downgrade rejection. Outages surface as errors, not as
missing state.

- Tests: `tests/live-store-contract.test.ts` (contract via the in-process RESP
  double `tests/support/resp-double.ts`, which implements WATCH/MULTI/EXEC with
  per-key versions; plus hardening: hashed keys, tampered records, encryption
  at rest/swap/rotation/downgrade, AUTH failure, invalid options, lease expiry,
  outage). Real Redis: `scripts/services-check.mjs` section `redis-live-store`
  (cross-instance continuation, replay and foreign binding rejection, busy across
  instances, revoke during a transaction aborts the commit, real `PX` TTL and
  lease expiry).
- Docs: `packages/realtime-redis/README.md`, ADR 0027,
  `docs/guides/production-services.md`.
- Gaps: Redis Cluster unsupported (commits span hash slots) — documented. The
  per-binding cap is approximate under races. About seven round trips per action;
  no load test.

## DATA-003 — Memory store with eviction and explicit caveats

Unchanged behavior; caveats now documented in `packages/live/README.md` (State
stores: process-local, bounded, lost on restart) and the contract suite covers it.
**Runnable example:** `examples/distributed-live` runs on `MemoryLiveStore` when
`REDIS_PORT` is unset (used by `tests/browser/realtime-transports.spec.ts`).

## DATA-010 — Queue integration or adapter abstraction; report demo with progress/success/failure/retry/cancel UI

**Implemented (adapter abstraction; BullMQ as a recipe).** `JobQueue` interface and
`MemoryJobQueue` default in `packages/realtime/src/jobs.ts`; `JobRunner` rewritten
over it (named handlers, JSON input). The starter-live report demo
(`examples/starter-live/src/realtime-board.ts`, `views/realtime-board.hbs`) gains
"Generate failing report" (two automatic attempts, then a generic failure),
attempts and error display, "Retry report", and cancel.

- Tests: `tests/realtime-jobs.test.ts`; browser `tests/browser/realtime.spec.ts`
  (new: cancel → `cancelled` + retry button; failing → `failed`, attempts 2,
  generic message, no internal text, retry → `succeeded`).
- Docs: `docs/guides/realtime.md` (Jobs, BullMQ adapter recipe), realtime README.
- Gap: no shipped BullMQ (or Redis) durable queue adapter — rationale in ADR 0027
  (BullMQ owns its worker loop/locks, needs Lua-capable Redis the unit suite
  cannot exercise, thin mapping). **Breaking (alpha)**: `enqueue/get/cancel/authorize`
  are async and handlers are registered by name.

## DATA-011 — Ownership, status expiration, idempotency, worker lifecycle, reconnect/results, observability

**Implemented** for the queue abstraction: owner-scoped idempotency keys (same
owner + key → same job, mismatch rejected), retention pruning, leases with renewal
and lapsed-lease reclaim (at-least-once), cross-worker cancellation via the queue
flag, `start()` polling for other processes, `close()`/`onApplicationShutdown`
handing running jobs back to the queue (wired automatically for Nest providers;
the starter-live runner is a provider), `nestvexa.job.run` spans (name/attempt
only).

- Tests: `tests/realtime-jobs.test.ts` (owner-only status/authorize, retries and
  redaction, idempotency incl. cross-owner and post-completion, cancel queued and
  running, retention expiry and capacity, validation, Nest shutdown hand-back,
  tracing without input, `MemoryJobQueue` lease contract, two runners on one queue
  incl. cross-runner cancellation).
- Gap: durability across restarts needs a durable `JobQueue` (none shipped).

## DATA-012 — Avoid bundling BullMQ/Redis by default; optional adapter with tests

Redis code lives only in the optional `@nestvexa/realtime-redis` package (and the
pre-existing opt-in `RespRealtimeBroker`); no client library dependency. Tested as
above. Gap: no BullMQ adapter (recipe only).

## REAL-002 — Broker/transport-neutral updates; optional `@nestvexa/realtime-redis`; Nest gateways/SSE

- `@nestvexa/realtime-redis` now exists; `@nestvexa/realtime-redis/realtime`
  exports `RedisRealtimeBroker` (re-export of `RespRealtimeBroker`, kept in
  `@nestvexa/realtime` for compatibility — deviation recorded in ADR 0027 §4).
- WebSocket: the raw `ws` upgrade handler is kept; justification recorded in
  ADR 0027 §5 (gateway would add peers and bypass hub checks); tested on Express
  and Fastify (`tests/realtime.test.ts`, `tests/realtime-hub.test.ts`).
- Gap: the broker implementation itself has not moved into the new package.

## REAL-004 — `polling | sse | websocket | auto`, negotiation and fallback

- `auto` now falls back at runtime from SSE to long-polling (two failures before
  `ready`, or 10 s silence) — `packages/client/src/realtime.ts`; controller
  exposes the resolved transport.
- Tests: `tests/client-realtime.test.ts` (unit, browser stand-ins: auto fallback on
  errors and on silence, no fallback once ready or for explicit SSE, polling when
  EventSource is missing); browser `tests/browser/realtime-transports.spec.ts`
  (WebSocket transport end to end; `auto` with SSE blocked by `page.route` falls
  back to polling and still refreshes).
- Gap: no per-component transport option (transport is per app/client); `auto`
  does not try WebSocket.

## REAL-005 — Authenticated handshake, tenant/user/channel authorization, revalidation

Tests added in `tests/realtime-hub.test.ts`: subscription-token expiry closes the
connection (hub timer) and a WebSocket with code 4000 `expired`; periodic identity
revalidation closes on a changed binding or a throwing (expired) session
(`revoked`); permission withdrawal closes on revalidation (`forbidden`);
`closeChannel` closes only that channel (SSE `event: close` reason `forbidden`, hub
and service level) and releases the broker subscription; multi-tenant isolation
(tenant-b token for tenant-a channel → 403 `CHANNEL_FORBIDDEN`, no cross-tenant
delivery, WebSocket 4003). Two-replica isolation in `tests/services/distributed.spec.ts`.

## REAL-006 — Backoff + jitter, heartbeat, cursor replay, circuit breaker, caps

- Circuit breaker added (after ten consecutive failures, one probe per five
  minutes; reset on `ready`/successful poll or `online`).
- Tests: `tests/client-realtime.test.ts` (exact backoff sequence 1→30 s cap,
  jitter bounds, circuit, reset after ready, offline pause and `online` resume,
  duplicate/malformed drop, expiry vs transient close, WebSocket cursor resume);
  `tests/realtime-hub.test.ts` (hub heartbeat interval and stop on shutdown; SSE
  `: ping`; WebSocket protocol ping; poll cursor replay; WebSocket cursor replay —
  on Express and Fastify).
- **Bug fixed (found by the WebKit run of the new job retry test):** every Live
  response re-signs realtime tokens with a fresh expiry, and the client
  reconnected its SSE/WebSocket on every such token change, opening a window in
  which events were missed (a retried report stayed "running"). The controller
  now keeps the open connection when the channel set is unchanged and uses the
  fresh tokens on the next connect (`tests/client-realtime.test.ts`).
- Gap: events published on a newly subscribed channel before its subscription
  is established are not replayed (at-most-once; documented). The demo job steps
  are 400 ms so the browser subscribes first.

## REAL-008 — Redis adapter, delivery guarantees, topology example

- Topology example: `examples/distributed-live` (two replicas + development proxy
  and Redis; README with diagram and env); guide section "Multiple replicas" in
  `docs/guides/realtime.md`.
- Stale "unverified" wording updated in `docs/guides/realtime.md`,
  `packages/realtime/README.md` and ADR 0009.
- Real-Redis check runs via `pnpm test:services`, now with the Live store and the
  two-replica browser suite, and in CI via `.github/workflows/services.yml`
  (`redis:7-alpine` service container). It remains outside `pnpm test` by design.

## REAL-009 — Presence, notifications, job progress, user/team channels, authorization

- Presence implemented: `describePresence` policy, `RealtimeHub.presence`,
  `RealtimeService.presence(identity, channel)` (authorized readers only,
  deduplicated, sorted, bounded by `maxPresenceMembers`, released on close).
  Tests: `tests/realtime-hub.test.ts`; used by `examples/distributed-live`
  ("viewers connected to this replica", asserted in the WebSocket browser test).
- Tenant channels tested (REAL-005 tests).
- Gaps: presence is per replica (no cross-replica aggregation); no dedicated
  live-notification/dashboard primitive.

## REAL-011 — Backpressure, payload quotas, rate limits, cost controls, graceful shutdown

- Per-identity `subscribesPerMinute` (every attempt counts, including rejected
  tokens) and `publishesPerMinute` (`publish(..., { identity })`), bounded counters,
  429 `RATE_LIMITED`.
- **Bug fixed:** `RealtimeService` ended streams only in `onApplicationShutdown`,
  which Nest calls after closing the HTTP server, so `app.close()` hung while SSE
  streams were open. Streams now end in `beforeApplicationShutdown`.
- Tests: `tests/realtime-hub.test.ts` (rate limits, 16 KiB payload quota and
  non-JSON rejection, `RealtimeService` shutdown closes SSE with reason `shutdown`
  and closes the broker on both adapters).

## REAL-014 — Two replicas + Redis + multiple browsers/users/tenants

`tests/services/distributed.spec.ts` with `playwright.services.config.ts`
(replica a :3220 SSE, replica b :3221 WebSocket, proxy :3222, real Redis):

1. An increment on replica B refreshes a browser whose SSE stream is held by
   replica A (asserted via `x-nestvexa-replica: a`), and an increment on A
   refreshes the browser on B over WebSocket.
2. A Live component created on A continues on B (revision 2 rendered by b); the
   replayed request is rejected with 409 on A.
3. Another identity's stolen subscription token (403) and snapshot (403/410) are
   rejected on both replicas; a forged identity cookie gets 401.

Gaps (still open): browser reconnect/deduplication across a replica restart,
subscription-leak checks and slow-client handling are only unit-tested (hub);
replicas in the acceptance suite run on Express only (Fastify covered at HTTP
level); no startup detection of per-adapter transport support (both adapters
support all transports and are tested; documented in the realtime guide).

## Not addressed

REAL-007/012 were already Done. REAL-010 (`@DependsOn`/query tags), DATA-006..008
(render caching), DATA-014..020 (ORM, auth, tenancy, i18n) are outside this
assignment and unchanged.

## Verification

Windows 11, Node 24.13.0, Docker Desktop 29.1.3, `redis:7-alpine` on host port 6390.

| Command                                                                                                                                                                    | Result                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm exec vitest run` on the 18 touched/related files (live-store-contract, realtime, realtime-hub, realtime-jobs, realtime-live, client-realtime, 11 Live suites, cache) | 18 files, 430 tests passed                                                    |
| `pnpm exec vitest run tests/client-realtime.test.ts tests/client-transport-lifecycle.test.ts`                                                                              | 72 passed                                                                     |
| Local Playwright config (starter-live :3225, distributed-live :3226 websocket, :3227 auto): `tests/browser/realtime.spec.ts tests/browser/realtime-transports.spec.ts`     | 24/24 passed on chromium, firefox and webkit                                  |
| `NESTVEXA_REDIS_PORT=6390 NESTVEXA_REDIS_CONTAINER=nv-agent-redis node scripts/services-check.mjs`                                                                         | redis (2 steps), redis-live-store (5 steps), two-replica browser (3/3) passed |
| `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`, `pnpm size:check` (44 948 / 49 152 gzip bytes), Prettier on changed files                                    | clean                                                                         |

Evidence file: `docs/implementation/services-evidence-2026-11-05.json` (the
services run was repeated on 2026-11-06 after the client reconnect fix, same
result). Ports 3223/3224 were occupied by another process on this host, so the
root-suite entries use 3226/3227.
