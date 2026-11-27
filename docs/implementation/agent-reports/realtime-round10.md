# Agent report: realtime round 10 (REAL-011, REAL-002, REAL-014, REAL-004, REAL-009, REAL-010, LIVE-007)

Branch `r10-realtime10`, from `main` at `748681d`, with `main` at `9df0757`
merged in. Windows 11, Node 24.13.0. Servers ran on ports 4380–4386 only, and
all tests ran one file and one browser at a time.

## REAL-011: drain-aware slow-consumer bound

**Implemented** (`packages/realtime/src/hub.ts`, `module.ts`). The 256 KiB
transport bound is no longer a disconnect threshold.

- A write that leaves an SSE stream's `writableLength` or a WebSocket's
  `bufferedAmount` above 256 KiB pauses delivery to that connection.
- Later events wait in the connection's ordered queue and are written when
  the transport drains. SSE uses the stream's `drain` event; WebSocket uses
  the `ws.send` callback once `bufferedAmount` falls below 64 KiB.
- The connection is closed as `slow-consumer` only when one of these holds:
  - the transport stays congested for `drainTimeoutMs` (new, default 10 s);
  - the queue exceeds `queueLimit` (default raised from 64 to 1024);
  - the queue exceeds `maxQueuedBytes` (new, default 4 MiB).
- Delivery is synchronous while authorization is fresh, so a burst published
  in one event-loop turn is queued rather than counted against the bound.
- `RealtimeSink` gains an optional `onDrain`. A custom sink without it keeps
  the old behaviour (closed at once when `send` returns false). Polling keeps
  its 64-event batch.

Tests: new `tests/realtime-backpressure.test.ts` (8).

- Hub level:
  - a single-turn burst of 140 × 15 KB to a draining sink arrives in full and
    in order, and the transport never held much more than its bound;
  - a congested sink that never drains is cut after `drainTimeoutMs`, and the
    healthy sink is not delayed;
  - the `maxQueuedBytes` and `queueLimit` cuts work;
  - a sink without `onDrain` is closed at once;
  - invalid new limits are rejected.
- Real transports, Express and Fastify, SSE and WebSocket: a **2 MiB burst
  in one turn** (`Promise.all` of 140 publishes, eight times the bound)
  reaches the healthy subscriber in full and in order, and it stays
  connected. A stalled subscriber on the same server is still cut
  (`slow-consumer`), and what it received was in order with no gaps.

**Checked against the old code:** with `main`'s `hub.ts`/`module.ts` restored
and rebuilt, the SSE burst test fails on both adapters (the healthy
subscriber received nothing). Existing slow-consumer tests still pass:
`tests/realtime.test.ts` (hub stalled-consumer and slow-consumer cases),
`tests/realtime-hub.test.ts` 17/17, and the slow-consumer cases in
`tests/realtime-distributed.test.ts`.

Docs: ADR 0032 round 10 amendment, the realtime README (Backpressure section),
and `docs/guides/realtime.md`.

## REAL-002: shared port with a Nest gateway; broker location

**Implemented.** `attachRealtimeWebSocket` claims upgrades for
`<endpoint>/ws` before any other `upgrade` listener sees them. It wraps the
HTTP server's `emit` for `upgrade` on that one path only; every other event
and path is emitted unchanged, and `detach()` restores `emit`. Nest's
`WsAdapter` destroys every upgrade whose path no gateway owns, which is why
the two could not share a port before.

`examples/api-coexistence` now attaches the transport beside a shared-port
gateway and beside an own-port gateway. The Live inventory subscribes to an
`items` channel published by REST writes. The upgrade identity is resolved by
running the host's express-session middleware on the raw upgrade request.

`tests/api-coexistence.test.ts` (14/14, run on ports 4380–4386 with the new
`NESTVEXA_COEXISTENCE_PORT`) checks both layouts:

- a page subscription receives the REST-triggered event;
- the gateway answers meanwhile;
- a bad token closes with 4003;
- a foreign `Origin` is refused;
- an upgrade without the page session is refused;
- unknown upgrade paths are still refused by the gateway's server.

**Broker move: re-checked and declined** (ADR 0032 round 10 amendment).

- `@nestvexa/realtime-redis` imports `@nestvexa/realtime` and requires the
  `@nestvexa/live` peer.
- A backward-compatible `RespRealtimeBroker` export from `@nestvexa/realtime`
  would need `realtime → realtime-redis`. That is a package cycle, and it
  would make Redis code and a Live peer mandatory for every realtime install.
- Leaving a copy behind would duplicate about 400 lines of protocol code.

The documented entry point is now `redisRealtime()` (see REAL-009).

Remaining:

- No Nest gateway class (the decision 5 rationale stands).
- Socket.IO on the same server is not tested.
- Upgrades for unknown paths on a server with no other listener are left
  unanswered, as before.

## REAL-014: tenant isolation across replicas, load smoke

- `examples/distributed-live` changes:
  - guests carry a tenant signed into the cookie (`/?tenant=acme` on first
    visit; it cannot change later), and the binding is `guest:<tenant>:<id>`;
  - a new `tenant-feed` component publishes on `tenant:<tenant>:feed`, which
    `authorizeChannel` admits only for that tenant;
  - the example uses `redisRealtime()`;
  - the acceptance load route takes `bytes=` and stamps events with `at`.
- `tests/services/distributed.spec.ts` "tenant A events never reach tenant B
  on any replica": acme on a (Express SSE) and d (Fastify WS), globex on b
  (Express WS) and c (Fastify SSE). Each tenant's announcements refresh only
  its own browsers, across replicas. The `nestvexa:realtime` channel log of
  each page never contains the other tenant's channel. An acme token is 403
  for a globex guest on all four replicas, and the tenant cannot be switched
  on a later visit.
- `scripts/services-check.mjs`, new section `redis-realtime-load`:
  - it starts two distributed-live replicas (Express and Fastify,
    `NESTVEXA_LOAD_BASE_PORT`, default 3240) on one Redis;
  - it opens `NESTVEXA_LOAD_CLIENTS` (default 200) SSE clients, each its own
    guest, split across the replicas;
  - it publishes `NESTVEXA_LOAD_EVENTS` (default 50) events on the Express
    replica;
  - it reports delivered/expected, loss rate, p50/p95/p99/max latency and
    per-replica counts (`report.load` in `artifacts/reports/services.json`);
  - the only failure condition is a replica that delivered nothing.

Not run here: see Verification.

## REAL-004: per-component transport

**Implemented.**

- `@LiveComponent({ realtime: { transport: 'auto' | 'sse' | 'websocket' |
'polling' } })` is validated at decoration and stored as
  `ComponentDefinition.realtimeTransport`.
- It is rendered as `data-nv-realtime-transport` next to the component's
  `data-nv-realtime` token, and only when the component has a subscription.
- The client (`packages/client/src/index.ts`) groups subscribed components
  by transport (component preference, else the page default) and runs one
  controller per group. Each `auto` group negotiates and falls back on its
  own connection. An event refreshes only the components of the connection
  that received it.
- Client size: 39,878 gzip core, 55,130 total (budgets 45,056 and 61,440).

Tests:

- `tests/live-dependencies.test.ts`: decoration validation, the attribute
  rendered only with a subscription, and no attribute without one.
- Browser `tests/browser/live-depends-on.spec.ts` (starter-live `/tags`):
  the stock summary uses polling while the order summary uses SSE. The SSE
  URL carries only the order token and the poll URL only the stock token, and
  each connection delivers its component's refresh.

## REAL-009: notifications primitive, presence by default with Redis

**Implemented.** `RealtimeNotifications` (`packages/realtime/src/notifications.ts`):

- one inbox per recipient key: the host `recipient(identity)`, by default the
  tenant-scoped kernel principal, else the session binding;
- each inbox has a private `notify:<sha256-40hex>` channel; no user id
  appears in channels, tokens or URLs;
- `authorize(identity, channel)` is meant for `authorizeChannel` and admits
  only the recipient's own identities;
- the API: `notify(recipient, { title, body?, kind?, data? })`,
  `notifyIdentity`, `list` (`{ unread, total, items }`), `unread`,
  `markRead(ids?)` and `clear`. Every change publishes
  `{ nvNotifications: { unread, latest? } }`;
- input is bounded (title 200, body 2000, kind grammar, data 4 KiB of JSON,
  `maxPerRecipient` 1–1000), and records from the store are re-validated
  (untrusted);
- `MemoryNotificationStore` (bounded LRU of inboxes) is the default, and the
  `NotificationStore` interface exists for shared stores.

`redisRealtime(options)` in `@nestvexa/realtime-redis/realtime` returns the
Redis broker **plus `RedisPresenceStore` presence by default**
(`presence: false` opts out; prefix validated; presence keys under
`<prefix>presence:`).

Tests:

- `tests/realtime-notifications.test.ts` (7):
  - inbox shared across sessions, unread count and published events;
  - isolation between users, tenants and identities without an inbox; a
    foreign id does not mark anything;
  - bounds and validation;
  - tampered store records dropped;
  - default recipient;
  - LRU cap;
  - over real SSE on Express and Fastify: both sessions of the recipient
    receive the count and `markRead` updates; Bob's stream gets nothing; Bob
    cannot sign Alice's channel, and Alice's token is 403 for him.
- `tests/realtime-distributed.test.ts` (+2): `redisRealtime()` on two
  replicas over the RESP double shares presence (total 2 across replicas)
  and carries events; `presence: false`, `ttlMs` and prefix validation.

Remaining: no Redis-backed `NotificationStore` ships (memory inboxes are per
replica, documented), and no example page uses the primitive.

## REAL-010: `@DependsOn` in an example, browser test

`examples/starter-live` `/tags` (`src/tagged-summaries.ts`):

- `OrderSummary` uses `@DependsOn('orders')` and `StockSummary` uses
  `@DependsOn('inventory')`, both read through `@Computed`;
- the `WarehouseControls` actions call `LiveTags.invalidate` for the one tag
  each write touched;
- the policy admits `tag:orders` and `tag:inventory`.

`tests/browser/live-depends-on.spec.ts`, with two sessions:

- placing an order in one session refreshes only `order-summary` in the
  other, and no `stock-summary/_sync` request is sent;
- restocking refreshes only `stock-summary`, delivered by long polling;
- both refreshes are read-only (revision stays 0).

The root `playwright.config.ts` already serves starter-live on 3102, so no
new entry is needed.

## LIVE-007: real-Redis coordination and replayed downloads

- **Replayed download URLs work on any replica**
  (`packages/live/src/downloads.ts`, `runtime.ts`).
  - When the store implements `LiveActionCoordination`, `storeDownload`
    writes the body as AES-256-GCM sealed 512 KiB chunks plus a manifest
    written last. Keys are digests of the 256-bit token, the sealing key is
    derived from the token (which the store never sees), and the record TTL
    is the download lifetime.
  - `download()` reads the manifest and checks expiry, component and owner
    (timing-safe) before consuming the token with a one-time lease
    (`SET NX`). It then verifies every chunk and the size. Any failure is
    404, and a store failure is 503 `STORE_UNAVAILABLE`.
  - The memory store path is unchanged.
- Tests: `tests/live-shared-action-policy.test.ts` (+3, two replicas over the
  RESP double, both adapter orders):
  - a 1.2 MB download created on A is replayed with the same URL by B;
  - another identity is refused without consuming it;
  - B serves it intact, and neither replica serves it twice;
  - the store holds no token, filename, body or binding;
  - two concurrent fetches on two replicas serve exactly one;
  - a tampered chunk is refused;
  - unknown tokens are 404.
- Real Redis:
  - new services-check section `redis-live-downloads`: written by one store
    and served by another; owner and component checks; single use;
    concurrent fetch; expiry;
  - new `tests/services/distributed.spec.ts` case: a download created on
    Express a and replayed on Fastify c is served once by Fastify d, 404 for
    another identity and 404 on every replica afterwards (`receipt` action in
    distributed-live).
- Cross-replica idempotent replay and identity locks on real Redis were
  already covered by the `redis-live-coordination` section (store level, two
  instances) and by the runtime-level browser cases "an idempotent retry
  replays on another replica" and "an identity-scoped action holds one lock
  across replicas". The row's clause is met by those once the services suite
  runs, so no further section was added.

## Verification

See the final message for the exact commands and results.
