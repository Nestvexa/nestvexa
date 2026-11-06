# ADR 0032: Pluggable Live state, Redis adapters and distributed realtime

Date: 2026-11-05. Status: **accepted; implemented** (`@nestvexa/live` store
interface, `@nestvexa/realtime-redis`, `JobQueue`), verified against an in-process
RESP test double in `pnpm test` and against Redis 7 in `pnpm test:services`.

## Context

Live state lived only in `MemoryLiveStore`, and the Live runtime factory rejected
anything else, so two replicas behind a load balancer could not continue each
other's components. The realtime broker already spoke the Redis protocol
(`RespRealtimeBroker`, ADR 0009), but it shipped inside `@nestvexa/realtime`
rather than the optional `@nestvexa/realtime-redis` package the specification
names, and nothing proved a browser on one replica receives an event published
on another.

## Decision

1. **`LiveStateStore` interface in `@nestvexa/live`.** `create`, `peek`,
   `transaction`, `revoke`, `delete`, `close`; every method may be synchronous or
   return a promise and `LiveRuntime` awaits all of them. The runtime factory
   accepts any object with these methods (structural check), and
   `MemoryLiveStore` stays the default. The interface documents the semantics a
   store must keep — exact identity binding, revision compare-and-set, one
   transaction per entry (`COMPONENT_BUSY`), invalidation on a failed callback
   (no retry of a revision that may have had effects), TTL, and no resurrection
   after revoke/delete/expiry during a transaction. One contract suite
   (`tests/live-store-contract.test.ts`) runs against every implementation.
   `close()` replaces the shutdown-time `clear()`: a memory store discards its
   entries, a shared store only closes connections.
2. **A new optional package, `@nestvexa/realtime-redis`**, holds the Redis
   adapters: `RedisLiveStore` and a zero-dependency `RespConnection` (RESP2 over
   `node:net`, pipelined, lazy reconnect, AUTH with ACL user, SELECT, command
   timeout). Peers: `@nestvexa/live` (required) and `@nestvexa/realtime`
   (optional, only for the `@nestvexa/realtime-redis/realtime` entry point). We
   did not add a Redis client library: the adapters use about fifteen commands,
   the RESP encoder/parser is small and bounded (8 MiB bulk, 65 536 array items,
   16 MiB buffer), and the default install stays free of Redis code.
3. **`RedisLiveStore` design.**
   - Keys hold SHA-256 hashes, never raw snapshot tokens or bindings:
     `<prefix>s:<sha256(token)>` (record), `<prefix>l:<sha256(token)>`
     (transaction lease), `<prefix>b:<sha256(binding)>` (per-identity index set
     used by `revoke` and the per-binding capacity cap). The binding is the host's
     tenant/user/session identity, so the index is the tenant/user namespace;
     `prefix` partitions applications and environments.
   - A transaction takes a lease with `SET NX PX lockTtlMs` (default 30 s),
     re-reads the record, runs the callback, then commits with
     `WATCH record lease` → check lease owner, id and revision → `MULTI SET XX PX
<remaining TTL>; DEL lease; EXEC`. A changed watched key aborts the commit
     and the entry is invalidated (410), exactly like a revoke during a memory
     transaction. An action that outlives its lease cannot commit. `create`
     writes record and index in one `MULTI`; `revoke` deletes under `WATCH` of the
     index and retries if an entry was created concurrently.
   - Records are versioned JSON validated on read with the same `cloneState`
     limits as browser input (no prototype keys, no non-JSON values, bounded
     size). Tampered or foreign records are indistinguishable from missing state.
   - Optional AES-256-GCM at rest (`encryptionKeys`, first encrypts, all decrypt,
     the Redis key is authenticated data so records cannot be swapped). Live
     state is public by design, so encryption is off unless policy requires it;
     with keys configured, plaintext records are rejected (no downgrade).
   - Targets one Redis primary (standalone or Sentinel-managed). Redis Cluster is
     **not** supported: the commit and revoke transactions span hash slots.
     Store clocks must be NTP-synchronized; Redis `PX` expiry is authoritative.
4. **Broker location.** `RespRealtimeBroker` stays implemented in
   `@nestvexa/realtime` for compatibility with existing imports and its
   verification history; `@nestvexa/realtime-redis/realtime` re-exports it as
   `RedisRealtimeBroker`, the documented distributed import. A future major may
   move the implementation. Delivery stays at-most-once per connected
   subscriber; Redis pub/sub is not durable, so a replica disconnected from Redis
   misses events and browsers recover by refreshing (no exactly-once claim).
5. **WebSocket transport.** `attachRealtimeWebSocket` remains a `ws` upgrade
   handler on the Nest HTTP server rather than a `@WebSocketGateway`: a gateway
   would require `@nestjs/websockets` plus a platform adapter as peers of every
   realtime install, and it would run its own handshake outside the hub's
   identity/token/origin checks. The handler is attached to Nest's own HTTP
   server, uses the same hub and policies as SSE/polling, and works on both
   Express and Fastify (tested). This is a recorded deviation from "integrate
   documented Nest gateways".
6. **Jobs.** `JobRunner` runs on a `JobQueue` interface (`MemoryJobQueue`
   default) with named handlers, JSON input, owner-scoped idempotency keys, leases
   and cooperative cancellation, so a durable queue can be plugged in. BullMQ is
   documented as an adapter recipe, not shipped: it owns its worker loop and
   locks, needs Lua-capable Redis that the unit suite cannot exercise without a
   real server, and would add a large optional dependency for a thin mapping.

## Consequences

Multi-replica Live and realtime work with one Redis primary; the acceptance test
`tests/services/distributed.spec.ts` (run by `pnpm test:services` and the
`services` GitHub workflow) proves a browser on replica A refreshes from an event
published on replica B and a component created on A continues on B. Costs: every
Live request now costs Redis round trips with the shared store (peek + lease +
re-read + WATCH commit, about seven); an action longer than the lease fails
closed. Redis Cluster, durable event replay across replicas and a shipped
BullMQ adapter remain open.
