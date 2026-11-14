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

   _Amendment (realtime round 3):_ the durable queue ships as `RedisJobQueue` in
   `@nestvexa/realtime-redis/realtime` (RESP, no client library): sorted-set
   indexes for queued/running/done, `WATCH`/`MULTI`/`EXEC` compare-and-set on
   every state change, lapsed-lease reclaim for crashed workers, owner-scoped
   idempotency keys and validated records. The BullMQ decision stands for a
   sharper reason: `JobQueue` is a storage contract (lease-conditional writes,
   a cancel flag visible to the running worker), which BullMQ's worker model
   cannot satisfy without bypassing it. Presence across replicas uses a
   `PresenceStore` (`RedisPresenceStore`): per-replica entries with `PX`
   expiry, so a crashed replica disappears within one TTL. The browser `auto`
   transport negotiates (`GET <endpoint>/negotiate`) and falls back
   WebSocket → SSE → polling.

## Consequences

Multi-replica Live and realtime work with one Redis primary; the acceptance test
`tests/services/distributed.spec.ts` (run by `pnpm test:services` and the
`services` GitHub workflow) proves a browser on replica A refreshes from an event
published on replica B and a component created on A continues on B, now with
Express and Fastify replicas side by side, shared presence, reconnects after a
dropped load balancer and connection-leak checks. Costs: every
Live request now costs Redis round trips with the shared store (peek + lease +
re-read + WATCH commit, about seven); an action longer than the lease fails
closed. Redis Cluster and durable event replay across replicas remain open; a
BullMQ adapter is declined (see 6).

## Amendment (protocol and realtime round 5, 2026-11-14): REAL-002

**Broker location (decision 4) stands.** Moving `RespRealtimeBroker` into
`@nestvexa/realtime-redis` with a backward-compatible re-export from
`@nestvexa/realtime` would make `@nestvexa/realtime` import
`@nestvexa/realtime-redis`. That package requires `@nestvexa/live` as a peer
and itself peers on `@nestvexa/realtime`, so the re-export would (a) create a
package cycle, (b) make Redis code and a Live peer mandatory for every realtime
install, which ADR 0009 rejected, and (c) break the optional-peer rule that
`scripts/boundaries.mjs` and the packaging ADRs enforce. The documented
distributed import stays `RedisRealtimeBroker` from
`@nestvexa/realtime-redis/realtime`; the class remains defined in
`@nestvexa/realtime` (about 400 lines, no client library). A future major may
remove the `RespRealtimeBroker` export from `@nestvexa/realtime` after a
deprecation cycle; that is the only way to move it without the cycle.

**WebSocket transport (decision 5): rationale and exact compatibility.** No
`@nestjs/websockets` gateway is shipped. Reasons, in order:

1. A Nest gateway owns its handshake and connection lifecycle through a
   platform adapter (`@nestjs/platform-ws` or `@nestjs/platform-socket.io`).
   Realtime authorization must happen in one place for every transport: exact
   `Origin` check before the upgrade completes, identity resolved from the raw
   upgrade request, signed identity-bound tokens in the first message within
   5 s, per-channel policy, revalidation, revocation, connection quotas and the
   256 KiB backpressure bound. The `ws` handler calls the same `RealtimeHub`
   as the SSE and polling controllers, so these rules cannot drift.
2. A gateway would add two peers (`@nestjs/websockets` and a platform adapter)
   to every realtime install, or a second package with its own release and
   test matrix, for a transport that already works on both HTTP adapters.
3. Socket.IO's own protocol (namespaces, rooms, acknowledgements) would be a
   second message format for the browser client to bundle; the client budget
   (ADR 0020) does not allow it.

Exact compatibility the handler gives:

| Aspect                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nest HTTP adapters          | Express and Fastify: `attachRealtimeWebSocket(app)` listens to `upgrade` on `app.getHttpServer()`; an adapter without upgrade events fails at startup (`tests/realtime-distributed.test.ts`).                                                                                                                                                                                 |
| Path                        | Only `<endpoint>/ws` (default `/_nestvexa/realtime/ws`, behind no global prefix). Upgrades for other paths are left untouched, so a host's own upgrade listeners for other paths keep working.                                                                                                                                                                                |
| Nest lifecycle              | The listener is removed by the returned `detach()`; open sockets close with the hub on `beforeApplicationShutdown`, like SSE streams.                                                                                                                                                                                                                                         |
| Guards, interceptors, pipes | Not applied (they are not applied to Nest gateways' handshakes either). Authorization is the realtime policy (`resolveUpgradeIdentity`, `authorizeChannel`).                                                                                                                                                                                                                  |
| Host `@WebSocketGateway`    | Not tested together. A gateway on **its own port** (`@WebSocketGateway(4001)`) is independent. A gateway on the same HTTP server through a platform adapter may reject or destroy upgrade requests for paths it does not own, which would break `<endpoint>/ws`; such hosts should give the gateway its own port or use the `sse`/`polling` transports (`transports` option). |
| Message format              | JSON text frames: client `{"tokens":[…],"cursor":"…"}`; server `{"type":"ready"}`, `{"type":"invalidate",channel,id,data}`; close codes 4000 (expired/slow/revoked, with the reason) and 4003 (rejected). Documented in the realtime guide.                                                                                                                                   |

The ledger deviation is therefore narrowed to "no Nest gateway class"; the
spec's intent (use Nest's HTTP server and lifecycle, no private competing
socket stack with its own authorization) is met. Revisit if Nest gains an
adapter-neutral upgrade hook that runs before gateways.

## Amendment (round 5): slow-subscriber evidence

The multi-replica acceptance suite gained "a stalled subscriber is
disconnected by its replica without slowing other browsers"
(`tests/services/distributed.spec.ts`, replica a publishes ~4.5 MB through
Redis, a stalled SSE client on Fastify replica c is closed as `slow-consumer`
while a browser on c receives every event; written this round but not yet run
against real Redis, see the round 5 report). The same scenario runs over the
RESP double in `tests/realtime-distributed.test.ts` (Express and Fastify
receivers) and a hub-level stalled-delivery test in `tests/realtime.test.ts`.
Finding: the per-connection bound is measured synchronously at `send`, so a
burst of more than 256 KiB published on one replica **within one event-loop
turn** (a tight in-process loop with the memory broker) exceeds the bound for
every local subscriber, healthy ones included; they are disconnected and
reconnect with replay. Events that arrive from Redis are spread over socket
reads and do not trigger it. The acceptance load route yields between
publishes for this reason. A drain-aware bound (close only when the buffer
stays above the limit after a grace period) is the recorded follow-up.

_Correction (round 6):_ the first version of both slow-subscriber tests
asserted that the stalled client received less than half of a fixed 4.5 MB.
On Linux CI it received 3.2–3.8 MB: what a stalled socket absorbs before the
replica sees backpressure is the 256 KiB stream bound **plus the kernel send
and receive buffers**, and Linux autotunes loopback TCP buffers to several MiB
(`net.ipv4.tcp_rmem`/`tcp_wmem` maxima), far more than Windows. A byte count
is therefore not the guarantee. The tests now publish in batches until the
replica disconnects the stalled subscriber, under a cap (60 MB in vitest,
45 MB in the services suite) an order of magnitude above any kernel
buffering, and assert what holds on every host: the disconnect happens
(buffering is bounded), the reason is `slow-consumer`, nothing published after
it reaches the stalled client, what it did receive is in order, and the
healthy subscriber receives every event in order throughout. Per-connection
memory on the server stays bounded by the 256 KiB check regardless of kernel
buffer sizes.
