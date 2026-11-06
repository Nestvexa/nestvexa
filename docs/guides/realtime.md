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

| Export                                                                     | Purpose                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `RealtimeModule.forRoot(options)` / `forRootAsync({ inject, useFactory })` | Registers `GET <endpoint>/sse` and `GET <endpoint>/poll` (default `/_nestvexa/realtime`) and a global `RealtimeService` |
| `RealtimeService.publish(channel, data?, { identity? })`                   | Invalidate subscribers; `data` is JSON ≤16 KiB; with `identity`, charged to `publishesPerMinute` (429 beyond)           |
| `RealtimeService.sign(identity, channels)`                                 | Token for authorized channels, or `undefined`                                                                           |
| `RealtimeService.presence(identity, channel)`                              | `{ members, total, truncated }` connected to this replica, for a reader authorized for the channel (403 otherwise)      |
| `RealtimeService.revoke(binding)` / `closeChannel(channel)`                | Close connections on logout or permission changes                                                                       |
| `attachRealtimeWebSocket(app)`                                             | Optional `<endpoint>/ws` transport; requires `resolveUpgradeIdentity`                                                   |
| `MemoryRealtimeBroker`                                                     | Default single-process broker with bounded replay                                                                       |
| `RespRealtimeBroker({ host, port, password?, prefix })`                    | Cross-replica pub/sub over the Redis protocol (also `RedisRealtimeBroker` from `@nestvexa/realtime-redis/realtime`)     |
| `JobRunner`, `MemoryJobQueue`, `JobQueue`                                  | Owner-bound jobs with progress, idempotency keys, retries, cancellation and leases over a pluggable queue               |
| `createTokenSigner`, `RealtimeHub`                                         | Lower-level building blocks                                                                                             |

Options: `secrets` (1–8, ≥32 bytes, first signs), `origin` (exact), `resolveIdentity`,
`authorizeChannel`, `describePresence?`, `resolveUpgradeIdentity?`, `broker?`, `endpoint?`,
`tokenTtlMs?` (default 15 min), `limits?` (`maxConnections` 1000,
`maxConnectionsPerIdentity` 8, `queueLimit` 64, `heartbeatMs` 15000, `revalidateMs`
30000, `subscribesPerMinute` 60, `publishesPerMinute` 120, `maxPresenceMembers` 100).

Browser: `createLiveClient({ realtime: { endpoint, transport: 'auto' | 'sse' | 'websocket' | 'polling' } })`
or the umbrella `browser.realtime` option. `auto` (default) starts with SSE and
falls back to long-polling for the page lifetime when SSE fails twice before its
`ready` event or stays silent for 10 s (for example a buffering proxy). Explicit
transports never switch. Reconnects back off exponentially from 1 s to 30 s with
×0.5–1 jitter; after ten consecutive failures the client probes once every five
minutes (circuit breaker) until a connection succeeds or the browser comes back
online. Duplicate event ids are dropped.

## Presence, rate limits and shutdown

- **Presence.** `describePresence(identity)` returns a public descriptor
  (`{ id, label? }`, never the binding); `presence(identity, channel)` lists
  distinct members, sorted and bounded by `maxPresenceMembers`, only to readers
  `authorizeChannel` allows. Presence is **per replica**: with several replicas
  each one reports its own connections (cross-replica aggregation is not
  implemented).
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

`get`, `cancel` and `authorize` are owner-only. Retention (`retentionMs`, default
10 min) prunes finished jobs; a lease (`leaseMs`, default 30 s, renewed while the
handler runs) lets another worker take over a job whose worker died, so handlers
must tolerate re-execution (at-least-once). `start()` polls the queue for jobs
enqueued by other processes; `close()` (also `onApplicationShutdown` when the
runner is a Nest provider) aborts handlers and hands their jobs back to the queue.
Spans `nestvexa.job.run` carry name and attempt only.

### BullMQ adapter recipe

Nestvexa does not ship a BullMQ adapter: BullMQ owns its worker loop and locks
and requires Lua-capable Redis, so a first-party adapter would be a thin, hard to
unit-test mapping. To use it, implement `JobQueue` over a BullMQ `Queue` and run
the handlers in a BullMQ `Worker` instead of `JobRunner.start()`:

- `add(record)`: `queue.add(record.name, record, { jobId: record.idempotencyKey ? `${record.owner}:${record.idempotencyKey}` : record.id, attempts: record.maxAttempts, removeOnComplete: { age } })` — BullMQ deduplicates by `jobId`; return the existing job's data when it already exists.
- `get(id)`: `queue.getJob(id)` mapped back to a `JobRecord` (`getState()`, `progress`, `returnvalue`, `attemptsMade`).
- `cancel(id)`: remove waiting jobs; for active jobs set a flag the worker's processor checks (BullMQ has no cooperative abort for running jobs).
- Worker: `new Worker(name, async (job) => handler({ input: job.data.input, progress: (p) => job.updateProgress(p), signal, attempt: job.attemptsMade + 1, id: job.id }))`, publishing `job:<id>` snapshots from the worker's `progress`, `completed` and `failed` events.

Keep owner checks in `get`/`cancel`/`authorize`, and never expose failure
messages to the browser.

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
clients refresh. Replay windows are per replica. Redis pub/sub is fire-and-forget:
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
- The same `secrets`, the same public `origin` and an identity that resolves
  identically on every replica (a shared session store or signed cookies).
- Long-lived SSE/WebSocket connections stay on the replica they opened; Live
  actions can land on any replica.

[`examples/distributed-live`](../../examples/distributed-live/README.md) is a
runnable topology (two replicas, a development proxy, Redis). `pnpm test:services`
runs its browser acceptance suite against real Redis (see
[production services](production-services.md)): an event published on replica B
refreshes a browser subscribed through replica A (SSE) and the reverse over
WebSocket, a Live component created on A continues on B, and another identity is
rejected on both replicas. Load testing remains unverified.

## HTTP adapters

SSE and long-polling are ordinary Nest controller routes and are tested on Express
and Fastify. `attachRealtimeWebSocket` handles `upgrade` events on Nest's HTTP
server and is tested on both adapters as well; it is a `ws` upgrade handler rather
than a `@WebSocketGateway`, so the same hub, tokens, origin check and policies
apply to every transport ([ADR 0027](../adr/0027-distributed-state-and-redis.md)).

## Testing

```sh
pnpm build && pnpm exec vitest run tests/realtime.test.ts tests/realtime-hub.test.ts \
  tests/realtime-jobs.test.ts tests/realtime-live.test.ts tests/client-realtime.test.ts \
  tests/live-store-contract.test.ts
pnpm exec playwright test tests/browser/realtime.spec.ts tests/browser/realtime-transports.spec.ts
NESTVEXA_REDIS_PORT=6379 pnpm test:services   # real Redis, two replicas
```

Example: [`/realtime`](../../examples/starter-live/src/realtime-board.ts) in the Live starter. Design records: [ADR 0009](../adr/0009-realtime-backpressure.md), [ADR 0027](../adr/0027-distributed-state-and-redis.md). Package reference: [@nestvexa/realtime](../../packages/realtime/README.md).

## Caching with declared dependencies

`@nestvexa/cache` can invalidate realtime subscribers when data changes: pass an
`onInvalidate` hook that publishes `tagChannel(tag)` and declare the same channels in
`@RealtimeChannels()`. Dependencies are explicit; nothing is detected automatically.
See the [cache package](../../packages/cache/README.md).
