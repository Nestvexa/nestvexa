# Agent report: realtime and data, round 3 (REAL, DATA)

Branch `worktree-agent-a426a32a57b5de2c9`, started from `main` at `4f7b859` and merged up to `main` at `8fe5afd` (which
already contains the Live round 2 branch). Builds on round 1
([realtime-data.md](realtime-data.md)). `RedisLiveStore` and
`LiveActionCoordination` are not modified here.

Real-service evidence: `redis:7-alpine` in Docker container `nv-r3-redis` on host
port 6395 (removed afterwards), Windows 11, Node 24.13.0. Servers on ports
3800–3814 only. See "Verification" at the end.

New test files: `tests/realtime-job-queue.test.ts`,
`tests/realtime-distributed.test.ts` (both added to `test:integration` and
`test:security`). Extended: `tests/client-realtime.test.ts`,
`tests/browser/realtime-transports.spec.ts`, `tests/services/distributed.spec.ts`,
`tests/support/resp-double.ts` (sorted sets, `INCR`), `scripts/services-check.mjs`.

## DATA-010 / DATA-011 / DATA-012 — durable queue adapter, worker lifecycle, BullMQ

**Implemented: `RedisJobQueue`** (`packages/realtime-redis/src/job-queue.ts`,
exported from `@nestvexa/realtime-redis/realtime`), a `JobQueue` for `JobRunner`
over the existing zero-dependency RESP client:

- `<prefix>j:<id>` JSON record, validated field by field on every read (a tampered
  or malformed record is never shown, authorized or executed; `claim` removes it
  from the work indexes); sorted sets `queued` (by `createdAt`), `running` (by
  `leaseUntil`) and `done` (by `finishedAt`); `<prefix>k:<sha256(owner, key)>`
  for owner-scoped idempotency keys (raw bindings never reach Redis; the owner is
  already a SHA-256).
- Every state change (`add`, `claim`, `update`, `cancel`, `prune`) is a
  `WATCH`/`MULTI`/`EXEC` compare-and-set on the job record with bounded retries,
  on a dedicated transaction connection. `update` applies only while the caller
  holds the lease, so a crashed worker's late write is refused.
- Crash recovery: `claim` takes lapsed leases first (`ZRANGEBYSCORE running -inf
now`), then the oldest queued job. At-least-once, `attempts` incremented.
- Retention: `prune(before)` deletes finished jobs older than the cutoff with
  their idempotency key (only if the key still points at that job).
- `close()` closes connections; jobs stay in Redis for other workers.
- Fixed in `MemoryJobQueue.claim` (found by the shared contract suite): it took
  the first job in insertion order; it now takes lapsed leases first, then the
  oldest queued job by `createdAt`, as the `JobQueue` contract documents.

Tests:

- `tests/realtime-job-queue.test.ts` — one contract suite run against
  `MemoryJobQueue` and `RedisJobQueue` (separate instances stand in for separate
  processes): add/get/idempotency incl. cross-owner; one lease holder, writes
  without the lease refused, lapsed-lease reclaim, crashed worker's late write
  refused; oldest-first and hand-back; cancel queued vs flag running (flag visible
  to the lease holder); prune with keys. Redis-only: six racing claimants get
  distinct jobs; restart (runner 1 shuts down with a running and a queued job,
  runner 2 on a new connection finishes both — the handed-back one on attempt 2 —
  with ownership and idempotency preserved); crash recovery (a claimant that never
  renews; another runner completes the job on attempt 2); tampered records
  (owner, status, version, progress, oversized error, non-JSON) → undefined and
  quarantined; invalid records, duplicate ids, bad prefix, outage and use after
  close.
- Real Redis, `scripts/services-check.mjs` section `redis-job-queue`: a job
  enqueued in this process is claimed by a **separate worker process**;
  idempotency and ownership hold across processes; the worker process is
  **SIGKILLed** mid-run and a new runner reclaims the lapsed lease and completes
  the job (attempt 2).

Docs: `packages/realtime-redis/README.md` (Durable jobs), `docs/guides/realtime.md`
(Jobs, BullMQ), `docs/deployment/multi-replica-redis.md`, ADR 0032 amendment,
production services guide.

**BullMQ: not shipped, documented why** (`docs/guides/realtime.md#bullmq`,
realtime-redis README, ADR 0032 §6 amendment). `JobQueue` is a storage contract
(atomic claim with lease, lease-conditional writes, a cancel flag visible to the
running worker, owner-scoped idempotency); BullMQ owns the worker loop, locks,
retries and backoff and cannot cooperatively cancel an active job, so an adapter
would bypass BullMQ's processing model or fail the contract, and would add
`bullmq` + `ioredis`. The guide shows how to use BullMQ directly with the
realtime job channels. DATA-012 is satisfied by `RedisJobQueue` being optional
(realtime-redis is opt-in, no client library), tested in-suite and against real
Redis.

Remaining: queue operations are serialized per queue instance on one transaction
connection (about five round trips each; progress uses the same path) — no load
test. Redis Cluster unsupported. Handlers must tolerate re-execution
(at-least-once, documented). The starter-live demo still uses the memory queue.

## REAL-009 — presence across replicas, expiry when a replica dies

**Implemented.**

- `PresenceStore` contract and `MemoryPresenceStore` (`packages/realtime/src/presence.ts`);
  module option `presence: { store, ttlMs? }` (default 30 s, 3–600 s).
- `RealtimeHub` gains an `onPresenceChange` hook and `presenceChannels()`;
  `RealtimeService` writes this replica's members per channel 50 ms after a change
  and every `ttlMs / 3`, removes entries when a channel empties and on graceful
  shutdown, and `presence()` merges every other replica's entry with its own live
  view. Store contents are untrusted: every member is re-validated, entries with
  invalid members or totals are dropped, results stay bounded by
  `maxPresenceMembers` (`total` becomes a lower bound and `truncated` true when a
  replica truncated). An unreachable store degrades to this replica's members.
- `RedisPresenceStore` (`packages/realtime-redis/src/presence-store.ts`):
  `<prefix>pm:<replica>:<channel>` with `PX` expiry, index set `<prefix>pr:<channel>`
  pruned lazily on read. **Bug found by the real-Redis check and fixed:** the
  index set's expiry was set to the writer's TTL, so a replica with a shorter TTL
  lapsing took the index (and every other replica's presence) with it; the index
  now has a fixed 24 h lifetime and entries carry the real TTL (regression test
  "keeps a long-lived replica when one with a shorter TTL lapses").

Tests: `tests/realtime-distributed.test.ts` — Express replica (SSE) + Fastify
replica (WebSocket) sharing `RedisPresenceStore` and `RespRealtimeBroker` over the
RESP double: both replicas report both members; another tenant gets 403; store
keys contain no binding/session; **replica b "killed"** (writes stop, its
WebSocket stays open) drops out after its TTL. Prompt removal on disconnect and
removal on graceful shutdown (`MemoryPresenceStore`); forged/invalid entries and
truncation; store outage fallback; option validation; Redis entry parsing and
lazy index pruning; mixed-TTL regression. Real Redis: services-check section
`redis-presence` (two processes merged and refreshed under TTL; the child process
SIGKILLed drops out after `PX` expiry; graceful remove). Browser, four replicas:
`tests/services/distributed.spec.ts` "presence counts viewers on every replica and
releases them when browsers leave" (each replica holds exactly one connection; the
page shows 4 viewers, then 1 after three browsers close).

Example: `examples/distributed-live` uses `RedisPresenceStore` with Redis
(`PRESENCE_TTL_MS`); page text "Viewers connected (all replicas when Redis is
configured)".

Remaining (unchanged from round 1): no dedicated live-notification/dashboard
primitive beyond the activity feed, job progress and this presence demo.

## REAL-004 — `auto` runtime fallback incl. WebSocket → SSE → polling; browser tests

**Implemented.**

- Server: `GET <endpoint>/negotiate` → `{ transports }` in preference order;
  `RealtimeService.transports` lists WebSocket only after `attachRealtimeWebSocket`;
  new `transports` option (default `['websocket','sse','polling']`) reorders or
  disables transports — disabled SSE/poll routes answer 404 `TRANSPORT_DISABLED`,
  and `attachRealtimeWebSocket` refuses when WebSocket is disabled.
- Client (`packages/client/src/realtime.ts`): `auto` fetches `negotiate`, keeps the
  transports the browser supports, starts with the first and moves down the list
  for the page lifetime when a transport fails twice before `ready` or stays silent
  10 s. WebSocket closes 4003 (server rejection) and 4000 (expiry) are not
  transport failures. Without negotiation (older server, network error, empty
  list) it keeps SSE → polling. Explicit transports never negotiate. Bundle:
  46 798 / 49 152 gzip bytes.
- Bug found by the new unit test and fixed before commit: the negotiated list was
  truncated before filtering unknown names.

Tests: `tests/client-realtime.test.ts` (negotiation request, WebSocket → SSE →
polling chain, unknown names ignored, 4003 and post-ready drops do not fall back,
open-but-silent socket falls back after 10 s, failed/empty negotiation keeps
defaults, dispose before negotiation settles, existing SSE→polling and silence
tests adapted). `tests/realtime-distributed.test.ts` (negotiate before/after
attach, detach, disabled transports → 404, invalid options, on Express and
Fastify). Browser `tests/browser/realtime-transports.spec.ts` — Chromium, Firefox,
WebKit, 18/18: WebSocket transport; **explicit polling** (only `/poll` requests);
**`auto` negotiates WebSocket**; **`auto` WebSocket → SSE** when upgrades are
refused (`page.routeWebSocket`, exactly two refused upgrades); **`auto` → polling**
when WebSocket and SSE are both blocked; **Fastify replica** negotiating WebSocket.

Remaining (honest gap): transport selection is per page, not per component — by
design one multiplexed connection serves every component (documented in the
guide and tutorial).

## REAL-014 — two-replica acceptance on Fastify and Express, real Redis

**Implemented.** `examples/distributed-live` runs on Express or Fastify
(`HTTP_ADAPTER`; guest cookie now issued through the platform adapter, not an
Express middleware) and reports adapter, offered transports and open connection
count on `/api/health`. The development proxy (`src/proxy.ts`) routes to up to
four replicas (`nv_replica=a|b|c|d`) and has `POST /__proxy/drop` to cut every
open connection. `playwright.services.config.ts` starts four replicas — a Express
SSE, b Express WebSocket, c Fastify SSE, d Fastify WebSocket — plus the proxy, with
`NESTVEXA_ACCEPT_BASE_PORT` (default 3220: a 3220, b 3221, proxy 3222, c 3223,
d 3224).

`tests/services/distributed.spec.ts`, 8 tests against real Redis (the two PROT-017 tests are described below):

1. (round 1) B → A over SSE and back over WebSocket.
2. (round 1) Live state created on A continues on B; replay rejected on A.
3. (round 1) Stolen token/snapshot and forged cookie rejected on both replicas.
4. **New:** events from Express a reach Fastify c (SSE) and Fastify d (WebSocket)
   and back; Live state created on Express a continues on Fastify c.
5. **New:** presence across all four replicas (see REAL-009) — also a
   subscription-leak check (each replica reports exactly one connection).
6. **New:** after the proxy drops every connection, an SSE browser (a) and a
   WebSocket browser (d) reconnect, receive new events, and never record the same
   event id twice (`nestvexa:realtime` events); one connection per browser after
   reconnecting and **zero connections on every replica** once browsers close.
7. **New:** idempotent retry replayed on another replica (PROT-017, below).
8. **New:** identity lock held across replicas and released (PROT-017, below).

Startup detection per adapter: `attachRealtimeWebSocket` throws at startup when
the HTTP server has no upgrade events (`tests/realtime-distributed.test.ts`), and
negotiation reports only available transports; both supported adapters carry all
three transports (now also proven in browsers).

Remaining: slow-client handling is still hub-level only (`tests/realtime-hub.test.ts`);
no load test across replicas; multi-tenant isolation across replicas is covered
by the identity-isolation test (one tenant) plus hub-level tenant tests.

**Bug found by the acceptance suite and fixed:** `RespRealtimeBroker.subscribe`
resolved as soon as `SUBSCRIBE` was written, so the hub could send `ready` (and
a browser act) before Redis had registered the subscription; an event published
in that window was lost. `subscribe` now resolves after Redis confirms the
channel (bounded at 5 s; a closed subscriber socket releases waiters and the
resubscription restores the channel). Tests: `tests/realtime-distributed.test.ts`
"Redis broker subscription confirmation" (a server that withholds the
confirmation keeps `subscribe` pending; 25 fresh channels each receive the event
published right after `subscribe` resolves). The acceptance tests also wait for
the client's realtime connection before clicking.

**Finding for the Live/client owners (not fixed here, outside this area):** when
a load balancer cuts a connection carrying a `$sync` that the replica already
committed, Chromium resends the POST on a new connection; the server correctly
answers `409 STALE_REVISION`, and the client then suspends the component
instead of resynchronizing (`packages/client/src/index.ts`, 409 is not in the
recoverable list although `STALE_REVISION`'s hint is `resync`). Seen once in
`tests/services/distributed.spec.ts` "browsers reconnect…" (trace: increment
201, `$sync` sent 11 ms later, drop 58 ms after that, `$sync` resent on a new
connection → 409, no further refreshes). The test now lets both refreshes finish
before the drop; the client behavior remains a gap.

## PROT-017 — shared Live replay and identity locks on real Redis

The `LiveActionCoordination` part of PROT-017 (request deduplication and
side-effect retry policy across replicas): `RedisLiveStore` already implements
it (`readReplay`/`writeReplay`, `acquireActionLease`/`releaseActionLease`) with
RESP-double tests (`tests/live-shared-action-policy.test.ts`). This round adds
real-Redis evidence; no store code changed.

- `scripts/services-check.mjs` section `redis-live-coordination` (two store
  instances): a replay record written by one is read by the other and expires
  by `PX`; an identity lease held by one excludes the other until released; a
  crashed holder's lease expires; a stale owner's late release does not drop the
  new owner's lease.
- `examples/distributed-live`: `pay` is `@Action({ idempotent: true })` (side
  effect counted in Redis, `GET /api/charges`); `exportAll` is
  `@Action({ concurrency: 'identity' })` (`EXPORT_DELAY_MS`, default 1500).
- `tests/services/distributed.spec.ts`, real Redis, four replicas:
  "an idempotent retry replays on another replica (Express → Fastify) without
  repeating the side effect" (first call on Express a; the retry with the same
  request ID on Fastify c returns `replayed: true` with the same snapshot and
  HTML; the charge count stays at +1; reusing the request ID for a different
  request on Fastify d is `422`, still +1) and "an identity-scoped action holds
  one lock across replicas and releases it" (while the export runs on a, the same
  identity on d gets `409 ACTION_BUSY`; another identity on d is not blocked;
  after the first export ends the same identity runs on d).

Docs: `docs/guides/production-services.md` (table and acceptance text),
`packages/realtime-redis/README.md`, `examples/distributed-live/README.md`.

Remaining for PROT-017 (other owners): canonicalization, envelope validation,
key rotation and the rest of the row belong to the Live protocol work; this
report covers only the cross-replica replay/lock evidence.

## REAL-008 — topology example and real-Redis coverage

The topology example now shows mixed Express/Fastify replicas, shared presence and
the four-replica acceptance suite; `docs/deployment/multi-replica-redis.md` was
stale (it still said Live state was per process and sticky sessions were required)
and is corrected. Real-Redis checks remain outside `pnpm test` by design
(`pnpm test:services`, CI workflow `services.yml`).

## REAL-002 — unchanged

`@nestvexa/realtime-redis/realtime` now also exports `RedisJobQueue` and
`RedisPresenceStore`. `RespRealtimeBroker` still lives in `@nestvexa/realtime`
(deviation recorded in ADR 0032 §4); WebSocket stays a `ws` upgrade handler
(ADR 0032 §5).

## REAL-001 / REAL-003 / REAL-013 / DATA-001 / DATA-009 — section headings

Children closed in this round: REAL-009 (presence), REAL-014 (to the documented
gaps above), DATA-010/011/012 (durable queue; BullMQ declined with rationale).
Still open children: REAL-004 (per-component transport, by design), REAL-005 /
REAL-006 / REAL-010 / REAL-011 as in round 1, DATA-004..008 and DATA-014..020 not
in scope.

## Not addressed

REAL-010 (`@DependsOn` / query tags) touches `@nestvexa/live`, which the Live
round 2 branch is changing; left alone to avoid conflicts. DATA-006..008 (render
caching) and DATA-014..020 (ORM examples, auth, tenancy, i18n) are outside this
assignment.

## Verification

Final session (2026-11-07), `redis:7-alpine` as `nv-r3-redis` on host port 6395.
The host was saturated by other work (CPU 99–100 %, about 50 node processes;
importing one package took 72 s by the end), which explains the timeouts below.

- `pnpm --filter @nestvexa/realtime-redis... --filter @nestvexa/client... --filter ./examples/distributed-live... build`: passed.
- `pnpm lint` (eslint + boundaries): passed. `pnpm exec tsc -p tsconfig.tests.json --noEmit`: no errors.
- `pnpm exec prettier --check` on every changed file: passed. `pnpm docs:build`:
  229 documents, 1646 API symbols, passed. `pnpm size:check`: 47 234 / 49 152 gzip bytes.
- `pnpm exec vitest run tests/realtime-distributed.test.ts tests/realtime-job-queue.test.ts tests/client-realtime.test.ts`:
  41/41 passed (with the broker fix). `tests/realtime.test.ts tests/realtime-live.test.ts tests/realtime-jobs.test.ts tests/realtime-hub.test.ts`:
  42/42. `tests/live-store-contract.test.ts`: 31/31.
- Later reruns under full saturation: the first test of `tests/realtime-distributed.test.ts`
  (presence, 20 s limit; import phase 185 s) and the first test of
  `tests/live-shared-action-policy.test.ts` (express → fastify replay, 60 s limit,
  cold Nest/Fastify/Handlebars start) timed out; every other test in both files
  passed, including the mirror fastify → express replay in 3 s. The second file
  and the Live/store code it exercises are identical to `main`.
- `NESTVEXA_REDIS_PORT=6395 NESTVEXA_REDIS_CONTAINER=nv-r3-redis NESTVEXA_ACCEPT_BASE_PORT=3810 node scripts/services-check.mjs`:
  - run 1: `redis` (incl. container restart), `redis-live-store`,
    `redis-live-coordination`, `redis-job-queue`, `redis-presence` passed; the
    browser section was killed by the old 900 s limit (server start-up took
    about 9 minutes), so the limit is now 30 minutes.
  - run 2: all sections passed except `redis-job-queue`, where the job finished
    on attempt 3 instead of 2 (a 1 s lease missed a renewal under load and the
    worker reclaimed its own job; leases are now 3 s). **Browser acceptance 8/8
    passed** (`tests/services/distributed.spec.ts`, Chromium, four replicas,
    15.3 min), including both PROT-017 tests and the reconnect test after its fix.
  - A direct Playwright run before the reconnect fix: 7/8 (the reconnect test
    failed as described under REAL-014; diagnosed from the trace).
  - run 3 (`NESTVEXA_SERVICES_BROWSER=0`), after the 3 s lease change: `redis-live-store`
    and `redis-live-coordination` passed; the three child-process sections timed
    out waiting for the child to start (60 s). **The 3 s lease change has
    therefore not yet passed against real Redis**; rerun
    `pnpm test:services` on an idle host.
- `tests/browser/realtime-transports.spec.ts` was not rerun in this session (18/18
  on Chromium, Firefox and WebKit in the earlier session, before the merges of
  `main` at `d0932cb` and `8fe5afd`).
- The container `nv-r3-redis` was removed afterwards.
