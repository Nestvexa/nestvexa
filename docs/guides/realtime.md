# Realtime updates

This guide covers authorized realtime invalidation for Nestvexa Live components: Server-Sent Events,
long-polling and an optional WebSocket transport, a process-local broker, a
Redis-protocol broker for multiple replicas, and an owner-bound job runner with
progress. Optional: the default `nestvexa` install does not include it.

## Install

```sh
npm install @nestvexa/realtime
# optional WebSocket transport
npm install ws
```

Peers: `@nestjs/common` and `@nestjs/core` 12, `reflect-metadata`, `rxjs`; `ws` 8
(optional). Node 22.13+ or 24.

## How it works

1. A Live component declares channels with `@RealtimeChannels()`.
2. The Live runtime calls the host signer (`RealtimeService.sign`) which keeps only
   the channels the current identity may read and returns an HMAC token. The token is
   embedded in the component root (`data-nv-realtime`) and refreshed on responses.
3. The browser client opens one connection for all tokens. Server code calls
   `realtime.publish(channel, data)`.
4. Each subscribed component refreshes through its own authorized `$sync` route.
   Pushed `data` is public and only surfaces as a window `nestvexa:realtime` event.

```ts
import { RealtimeModule, RealtimeService } from '@nestvexa/realtime';
import {
  NestvexaModule,
  RealtimeChannels,
  State,
  LiveComponent,
} from 'nestvexa';

@LiveComponent({ name: 'orders', view: 'orders' })
class Orders {
  @RealtimeChannels() channels(): string[] {
    return [`orders:${this.tenantId}`];
  }
}

@Module({
  imports: [
    RealtimeModule.forRoot({
      secrets: [process.env.REALTIME_SECRET!],
      origin: 'https://app.example.com',
      resolveIdentity: (request) => ({ binding: sessionBinding(request) }),
      authorizeChannel: (identity, channel) =>
        policies.canRead(identity, channel),
    }),
    NestvexaModule.forRoot(config, {
      components: [Orders],
      browser: { realtime: { endpoint: '/_nestvexa/realtime' } },
      inject: [RealtimeService],
      useFactory: (realtime: RealtimeService) => ({
        /* origin, policies */ realtime,
      }),
    }),
  ],
})
class AppModule {}
```

Hosts must authorize `$sync` for components that use realtime.

## Public API

| Export                                                                     | Purpose                                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `RealtimeModule.forRoot(options)` / `forRootAsync({ inject, useFactory })` | Registers `GET <endpoint>/sse` and `GET <endpoint>/poll` (default `/_nestvexa/realtime`) and a global `RealtimeService`       |
| `RealtimeService.publish(channel, data?, { identity? })`                   | Invalidate subscribers; `data` is JSON ≤16 KiB; with `identity`, charged to `publishesPerMinute` (429 beyond)                 |
| `RealtimeService.sign(identity, channels)`                                 | Token for authorized channels, or `undefined`                                                                                 |
| `RealtimeService.presence(identity, channel)`                              | `{ members, total, truncated }` for a reader authorized for the channel (403 otherwise); all replicas with a `presence` store |
| `RealtimeService.transports`, `GET <endpoint>/negotiate`                   | Transports offered now, in preference order; `auto` clients negotiate with it                                                 |
| `RealtimeService.revoke(binding)` / `closeChannel(channel)`                | Close connections on logout or permission changes                                                                             |
| `attachRealtimeWebSocket(app)`                                             | Optional `<endpoint>/ws` transport; requires `resolveUpgradeIdentity`                                                         |
| `MemoryRealtimeBroker`                                                     | Default single-process broker with bounded replay                                                                             |
| `RespRealtimeBroker({ host, port, password?, prefix })`                    | Cross-replica pub/sub over the Redis protocol (also `RedisRealtimeBroker` from `@nestvexa/realtime-redis/realtime`)           |
| `JobRunner`, `MemoryJobQueue`, `JobQueue`                                  | Owner-bound jobs with progress, idempotency keys, retries, cancellation and leases over a pluggable queue                     |
| `MemoryPresenceStore`, `PresenceStore`                                     | Shared presence contract; `RedisPresenceStore` in `@nestvexa/realtime-redis/realtime`                                         |
| `RedisJobQueue` (`@nestvexa/realtime-redis/realtime`)                      | Durable `JobQueue`: restarts, multiple workers, crash recovery                                                                |
| `createTokenSigner`, `RealtimeHub`                                         | Lower-level building blocks                                                                                                   |

Options: `secrets` (1–8, ≥32 bytes, first signs), `origin` (exact), `resolveIdentity`,
`authorizeChannel`, `describePresence?`, `resolveUpgradeIdentity?`, `broker?`,
`presence?` (`{ store, ttlMs? }`), `transports?` (default `['websocket', 'sse', 'polling']`), `endpoint?`,
`tokenTtlMs?` (default 15 min), `limits?` (`maxConnections` 1000,
`maxConnectionsPerIdentity` 8, `queueLimit` 64, `heartbeatMs` 15000, `revalidateMs`
30000, `subscribesPerMinute` 60, `publishesPerMinute` 120, `maxPresenceMembers` 100).

Browser: `createLiveClient({ realtime: { endpoint, transport: 'auto' | 'sse' | 'websocket' | 'polling' } })`
or the umbrella `browser.realtime` option. `auto` (default) first asks
`GET <endpoint>/negotiate` which transports the server offers — WebSocket is
listed only after `attachRealtimeWebSocket`, and the `transports` module option
can remove or reorder any — keeps the ones the browser supports, and starts with
the first. A transport that fails twice before its `ready` notice (an upgrade
refused by a proxy, a blocked event stream) or stays silent for 10 s (a
buffering proxy) is replaced by the next one for the page lifetime, so the usual
chain is WebSocket → SSE → long-polling. A server rejection of the subscription
(WebSocket close 4003, HTTP 403) is not a transport failure. Against a server
without negotiation the order is SSE → polling. Explicit transports never
negotiate or switch. Transport selection is per page, not per component: one
multiplexed connection serves every component on the page. Reconnects back off exponentially from 1 s to 30 s with
×0.5–1 jitter; after ten consecutive failures the client probes once every five
minutes (circuit breaker) until a connection succeeds or the browser comes back
online. Duplicate event ids are dropped.

## Presence, rate limits and shutdown

- **Presence.** `describePresence(identity)` returns a public descriptor
  (`{ id, label? }`, never the binding); `presence(identity, channel)` lists
  distinct members, sorted and bounded by `maxPresenceMembers`, only to readers
  `authorizeChannel` allows. Without a store it covers this replica. With
  `presence: { store: new RedisPresenceStore(redis), ttlMs }` every replica
  writes its members per channel (50 ms after a change and every `ttlMs / 3`)
  and `presence()` merges all live entries; a replica that shuts down removes
  its entries, and one that crashes drops out when its entry expires (within
  `ttlMs`, default 30 s). Entries read from the store are re-validated. If a
  replica truncated its own list, `total` is a lower bound and `truncated` is
  true. While the store is unreachable `presence()` falls back to this
  replica's members.
- **Rate limits.** Every subscription attempt (SSE, poll, WebSocket handshake)
  counts against `subscribesPerMinute` per identity, including attempts with
  rejected tokens. Pass `{ identity }` to `publish` for user-triggered events so
  `publishesPerMinute` applies; server-originated publishes are not charged. Both
  reply 429 `RATE_LIMITED`; the counters are per process and bounded.
- **Shutdown.** `RealtimeService` closes every connection with reason `shutdown`
  in `beforeApplicationShutdown`, before Nest closes the HTTP server, then closes
  the broker. Clients reconnect with backoff.

## Jobs

`JobRunner` runs named handlers over a `JobQueue` (default `MemoryJobQueue`,
process-local). Register handlers in every worker process; jobs carry JSON input
(≤16 KiB), are bound to the enqueuing identity and publish snapshots on
`job:<id>`:

```ts
const jobs = new JobRunner({
  notify: (channel, job) => realtime.publish(channel, { status: job.status }),
}).register('report', async ({ input, signal, progress }) => {
  progress(50);
  return buildReport(input, signal);
});
const job = await jobs.enqueue(identity, 'report', {
  input: { month: '2026-11' },
  idempotencyKey: `report:${requestId}`, // same owner + key → same job
  maxAttempts: 3,
});
```

For restarts and several workers pass `queue: new RedisJobQueue(redis)` from
`@nestvexa/realtime-redis/realtime`: jobs, leases and idempotency keys live in
Redis, each state change is a `WATCH`/`MULTI`/`EXEC` compare-and-set, and a job
whose worker process died is claimed again when its lease lapses. Call
`start()` in every worker so it polls for work.

`get`, `cancel` and `authorize` are owner-only. Retention (`retentionMs`, default
10 min) prunes finished jobs; a lease (`leaseMs`, default 30 s, renewed while the
handler runs) lets another worker take over a job whose worker died, so handlers
must tolerate re-execution (at-least-once). `start()` polls the queue for jobs
enqueued by other processes; `close()` (also `onApplicationShutdown` when the
runner is a Nest provider) aborts handlers and hands their jobs back to the queue.
Spans `nestvexa.job.run` carry name and attempt only.

### BullMQ

No BullMQ adapter ships, deliberately. `JobQueue` is a storage contract —
atomic claim with a lease, writes conditional on the lease holder, a cancel
flag visible to the running worker, owner-scoped idempotency — while BullMQ
owns the worker loop, locks, retries and backoff and cannot cooperatively
cancel an active job. An adapter would either bypass BullMQ's processing model
or fail the contract, and would add `bullmq` and `ioredis` to the install.
`RedisJobQueue` covers durable jobs with no client library. If you already run
BullMQ, use it directly and reuse the browser side: keep the owner check in your
controller, authorize `job:<id>` channels against your own job store, and
publish progress from the BullMQ `Worker` (`realtime.publish('job:' + job.id,
{ status, progress })`) without exposing failure messages.

## Security

- Knowing a channel name is not authorization: tokens are identity-bound and every
  channel is re-authorized at subscribe, periodically and before delivery.
- Tokens are signed, not encrypted; channel names are visible to the browser.
- SSE tokens travel in the query string; keep them out of shared access logs.
- WebSocket upgrades require the exact configured `Origin`.
- Slow consumers are disconnected rather than buffered without bound.
- Pushed data is never applied as server state; components re-render through the
  normal Live security pipeline.

## Delivery semantics and limits

At-most-once per connected subscriber; no path claims exactly-once delivery. The
memory broker replays the last 100 events per channel after reconnect (SSE
`Last-Event-ID`, poll and WebSocket cursors); unknown cursors replay nothing and
clients refresh. Replay windows are per replica. `RespRealtimeBroker.subscribe`
resolves once Redis confirms the subscription, so a connection is reported
`ready` only when events published from then on reach it. Redis pub/sub is
fire-and-forget:
a replica disconnected from Redis misses events and its browsers recover with an
authorized refresh.

## Multiple replicas

Run the replicas behind any load balancer (sticky sessions are not required) and
share three things: Redis, the secrets, and identity.

```text
browsers ──► load balancer ──► replica a ─┐  RedisRealtimeBroker (PUBLISH/SUBSCRIBE)
                          └──► replica b ─┴► RedisLiveStore (shared Live state)
```

- `broker: new RedisRealtimeBroker({ host, port, password, prefix })` and Live
  `store: new RedisLiveStore({ host, port, password, prefix })` from
  [`@nestvexa/realtime-redis`](../../packages/realtime-redis/README.md).
  `nestvexa add redis` generates this wiring (`src/nestvexa/redis.config.ts`):
  both switch to Redis when `REDIS_URL` is set and stay in-process otherwise.
- The same `secrets`, the same public `origin` and an identity that resolves
  identically on every replica (a shared session store or signed cookies).
- Long-lived SSE/WebSocket connections stay on the replica they opened; Live
  actions can land on any replica.

- Optionally `presence: { store: new RedisPresenceStore(redis) }` for presence
  across replicas and `queue: new RedisJobQueue(redis)` for durable jobs.

[`examples/distributed-live`](../../examples/distributed-live/README.md) is a
runnable topology (replicas on Express and Fastify, a development proxy, Redis).
`pnpm test:services` runs its browser acceptance suite against real Redis with
four replicas (Express SSE, Express WebSocket, Fastify SSE, Fastify WebSocket;
see [production services](production-services.md)): events published on any
replica refresh browsers held by the others over both transports and both
adapters; a Live component created on one replica continues on another,
including from Express to Fastify; another identity is rejected on every
replica; presence counts viewers on all four replicas and releases them when
browsers leave; after the load balancer drops every connection, browsers
reconnect, receive new events and never see an event id twice; and no replica
keeps a connection after its browsers close. Load testing remains unverified,
and slow-consumer disconnection is covered by hub tests, not end to end.

## HTTP adapters

SSE and long-polling are ordinary Nest controller routes and are tested on Express
and Fastify. `attachRealtimeWebSocket` handles `upgrade` events on Nest's HTTP
server and is tested on both adapters as well (also in browsers, including a
mixed Express/Fastify deployment). At startup it refuses an adapter whose HTTP
server has no `upgrade` events, and `GET <endpoint>/negotiate` reports only
the transports actually available, so clients never assume parity; it is a `ws` upgrade handler rather
than a `@WebSocketGateway`, so the same hub, tokens, origin check and policies
apply to every transport ([ADR 0032](../adr/0032-distributed-state-and-redis.md)).
Nest's `WsAdapter` (`@nestjs/platform-ws`) destroys upgrades for paths it does
not own, so it cannot share an HTTP server with this transport; see
[coexistence](coexistence.md#rest-graphql-microservices-and-websocket-gateways).

## Testing

```sh
pnpm build && pnpm exec vitest run tests/realtime.test.ts tests/realtime-hub.test.ts \
  tests/realtime-jobs.test.ts tests/realtime-live.test.ts tests/client-realtime.test.ts \
  tests/live-store-contract.test.ts tests/realtime-job-queue.test.ts tests/realtime-distributed.test.ts
pnpm exec playwright test tests/browser/realtime.spec.ts tests/browser/realtime-transports.spec.ts
NESTVEXA_REDIS_PORT=6379 pnpm test:services   # real Redis, four replicas
```

Example: [`/realtime`](../../examples/starter-live/src/realtime-board.ts) in the Live starter. Design records: [ADR 0009](../adr/0009-realtime-backpressure.md), [ADR 0032](../adr/0032-distributed-state-and-redis.md). Package reference: [@nestvexa/realtime](../../packages/realtime/README.md).

## Caching with declared dependencies

`@nestvexa/cache` can invalidate realtime subscribers when data changes: pass an
`onInvalidate` hook that publishes `tagChannel(tag)` and declare the same channels in
`@RealtimeChannels()`. Dependencies are explicit; nothing is detected automatically.
See the [cache package](../../packages/cache/README.md) and the [caching and stores guide](caching.md).
