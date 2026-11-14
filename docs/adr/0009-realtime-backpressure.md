# ADR 0009: Authorized invalidation events with bounded delivery

Date: 2026-10-25; implementation recorded 2026-11-01, distributed acceptance 2026-11-05. Status: **implemented in `@nestvexa/realtime` and `@nestvexa/realtime-redis` (experimental); broker, Live store and two-replica browser acceptance pass against real Redis; load testing and browser reconnect/deduplication across a replica restart remain open**. Distributed state and the Redis adapters: [ADR 0032](0032-distributed-state-and-redis.md).

## Decision

Realtime events request refresh of an explicitly registered component or dependency tag. They do not contain arbitrary method names to execute. Each subscription is authorized using current host identity, tenant and channel policy. Reconnect, session expiry and permission changes require revalidation; knowing a channel name is not authorization. The server recomputes protected view data on refresh rather than trusting a push payload as authoritative component state.

Use Nest-supported SSE and gateway/WebSocket integration points. Start with a transport that can be tested on each HTTP adapter, while retaining polling as an explicit capability/fallback. A failed private subscription must not degrade into an anonymous public stream. Multiple frontend consumers may share transport infrastructure only when their identities, authorization scopes and lifecycle are identical.

Every connection has bounded queued events, payload bytes, heartbeat interval, idle lifetime and refresh rate. Coalescing repeated invalidations is safe when they identify the same authorized scope; coalescing across users or tenants is forbidden. Slow clients are disconnected or sent a resynchronization requirement according to documented policy. Reconnect uses bounded exponential backoff with jitter; hidden pages reduce polling. Cancellation and application shutdown remove listeners/subscriptions and release broker resources.

The first local broker may be process-local. A Redis pub/sub extension is separate and must state its delivery semantics: disconnected clients can miss events, publication is not durable replay, and neither path claims exactly-once delivery. Cursor replay requires a durable backing mechanism with its own retention and authorization checks. Clients deduplicate IDs where supplied and recover from gaps using a fresh authorized state read.

## Alternatives, costs and failures

Unbounded per-socket buffers were rejected because a slow client can exhaust memory. Broadcasting full private component HTML to broad channels was rejected because filtering mistakes disclose data. A mandatory Redis dependency was rejected to keep the default installation small. A custom socket stack was rejected in favor of Nest integrations.

Costs include heartbeat/refresh traffic, revocation tracking and deployment-specific quotas. Failures include broker outage, missed invalidations, duplicate delivery, reconnect storms and a session expiring while connected. The safe fallback is bounded retry or disconnected status, never weakened authorization or unbounded buffering.

## Acceptance gates

Required evidence is two server processes, a real Redis test service, multiple users/tenants, SSE and WebSocket adapter checks, revocation mid-connection, broker restart, slow-client pressure, deduplication and listener cleanup.

_As of 2026-10-25 (superseded):_ no test proved realtime behavior and the Docker daemon was unavailable, so the distributed tests were unrun. The implementation and update sections below record the evidence that now exists: real Redis 7 runs of `scripts/services-check.mjs` and the two- and four-replica browser suite `tests/services/distributed.spec.ts` (`pnpm test:services`). Load tests and reconnect/deduplication across a replica restart in a browser remain unrun.

## Implementation (2026-11-01)

`@nestvexa/realtime` implements this decision:

- **Invalidation only.** Components declare channels with `@RealtimeChannels()`. The
  Live runtime asks the host-configured signer for a token covering the channels the
  identity may read now; events trigger the component's own authorized `$sync`
  refresh. Event `data` is public JSON (≤16 KiB) delivered as a window event, never
  applied as component state.
- **Tokens.** HMAC-SHA256, identity-bound (SHA-256 of the binding), 1–32 channels,
  default 15-minute expiry, key rotation (first secret signs, all verify). Signed,
  not encrypted.
- **Authorization.** Checked at subscribe, before delivery after each revalidation
  window (default 30 s), and periodically with a fresh identity resolution;
  `revoke(binding)` and `closeChannel(channel)` close connections immediately.
- **Bounds.** 1000 connections, 8 per identity, 64 queued events per connection,
  256 KiB transport buffer; slow consumers are disconnected. Heartbeats every 15 s.
- **Transports.** SSE and long-polling routes on both Express and Fastify; optional
  WebSocket upgrade (`ws` peer) with an exact-Origin check against cross-site
  WebSocket hijacking and identity resolved from the raw upgrade request. Clients
  reconnect with exponential backoff and jitter, pause offline, deduplicate ids and
  renew expired tokens through ordinary refreshes.
- **Brokers.** In-process broker with a bounded replay window (SSE `Last-Event-ID`,
  poll cursors). `RespRealtimeBroker` speaks the Redis PUBLISH/SUBSCRIBE protocol
  without a client library; Redis pub/sub is fire-and-forget, so disconnected
  replicas miss events and clients recover with a fresh refresh.
- **Jobs.** `JobRunner` is an in-process, owner-bound job runner with progress,
  bounded retries, cancellation and redacted failures, publishing snapshots to
  `job:<id>` channels. It does not survive restarts; durable queues (for example
  BullMQ) are a host adapter behind the same shape.

Evidence: `tests/realtime.test.ts` (tokens, hub limits/revocation/replay, two
replicas through an in-process RESP **test double**, SSE/poll/WebSocket on both
adapters, jobs), `tests/realtime-live.test.ts` and `tests/browser/realtime.spec.ts`
(cross-session SSE refresh, owner job progress, forged/foreign tokens, axe).
`scripts/services-check.mjs` ran against Redis 7 on 2026-11-02: delivery across two OS
processes and resubscription after a broker restart (the run found and fixed missing
resubscription).

## Update (2026-11-05)

- Presence (`describePresence`, `RealtimeService.presence`, per replica, bounded,
  authorized readers only), per-identity `subscribesPerMinute` and
  `publishesPerMinute` limits, and streams closed in `beforeApplicationShutdown`
  (previously `app.close()` waited on open SSE streams).
- Client `auto` transport falls back from SSE to long-polling at runtime; a
  circuit breaker probes every five minutes after ten consecutive failures.
- `JobRunner` runs over a pluggable `JobQueue` with idempotency keys and leases.
- Evidence: `tests/realtime-hub.test.ts`, `tests/realtime-jobs.test.ts`,
  `tests/client-realtime.test.ts`, `tests/browser/realtime-transports.spec.ts`
  (WebSocket and `auto` fallback in real browsers) and
  `tests/services/distributed.spec.ts` via `pnpm test:services`: two Nest replicas
  (SSE and WebSocket) behind a proxy share Redis; an event published on one
  replica refreshes a browser on the other in both directions, a Live component
  created on one replica continues on the other, and foreign identities are
  rejected on both. Still unrun: load tests and reconnect/deduplication across a
  replica restart in a browser.

## Update (realtime round 3)

- Presence can span replicas through a `PresenceStore` (`RedisPresenceStore`):
  per-replica entries with expiry, re-validated on read, bounded per query.
- `auto` clients negotiate transports (`GET <endpoint>/negotiate`) and fall
  back WebSocket → SSE → polling; disabled transports answer 404, and the
  WebSocket transport refuses at startup an adapter without upgrade events.
