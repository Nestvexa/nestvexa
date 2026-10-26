# ADR 0009: Authorized invalidation events with bounded delivery

Date: 2026-10-25. Status: **planned; no realtime transport/broker implementation is claimed**.

## Decision

Realtime events request refresh of an explicitly registered component or dependency tag. They do not contain arbitrary method names to execute. Each subscription is authorized using current host identity, tenant and channel policy. Reconnect, session expiry and permission changes require revalidation; knowing a channel name is not authorization. The server recomputes protected view data on refresh rather than trusting a push payload as authoritative component state.

Use Nest-supported SSE and gateway/WebSocket integration points. Start with a transport that can be tested on each HTTP adapter, while retaining polling as an explicit capability/fallback. A failed private subscription must not degrade into an anonymous public stream. Multiple frontend consumers may share transport infrastructure only when their identities, authorization scopes and lifecycle are identical.

Every connection has bounded queued events, payload bytes, heartbeat interval, idle lifetime and refresh rate. Coalescing repeated invalidations is safe when they identify the same authorized scope; coalescing across users or tenants is forbidden. Slow clients are disconnected or sent a resynchronization requirement according to documented policy. Reconnect uses bounded exponential backoff with jitter; hidden pages reduce polling. Cancellation and application shutdown remove listeners/subscriptions and release broker resources.

The first local broker may be process-local. A Redis pub/sub extension is separate and must state its delivery semantics: disconnected clients can miss events, publication is not durable replay, and neither path claims exactly-once delivery. Cursor replay requires a durable backing mechanism with its own retention and authorization checks. Clients deduplicate IDs where supplied and recover from gaps using a fresh authorized state read.

## Alternatives, costs and failures

Unbounded per-socket buffers were rejected because a slow client can exhaust memory. Broadcasting full private component HTML to broad channels was rejected because filtering mistakes disclose data. A mandatory Redis dependency was rejected to keep the default installation small. A custom socket stack was rejected in favor of Nest integrations.

Costs include heartbeat/refresh traffic, revocation tracking and deployment-specific quotas. Failures include broker outage, missed invalidations, duplicate delivery, reconnect storms and a session expiring while connected. The safe fallback is bounded retry or disconnected status, never weakened authorization or unbounded buffering.

## Acceptance gates

No existing MVC test proves realtime behavior. Required evidence is two server processes, a real Redis test service, multiple users/tenants, SSE and WebSocket adapter checks, revocation mid-connection, broker restart, slow-client pressure, deduplication and listener cleanup. The local Linux Docker daemon was unavailable at the compatibility checkpoint; distributed/container tests remain unrun. All realtime feature-ledger units remain unmet until implementation and these tests exist.
