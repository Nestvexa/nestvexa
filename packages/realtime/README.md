# @nestvexa/realtime

Authorized realtime invalidation for Nestvexa Live components: Server-Sent Events,
long-polling and an optional WebSocket transport, a process-local broker, a
Redis-protocol broker for multiple replicas, and an owner-bound job runner with
progress. Optional: the default `nestvexa` install does not include it.

## Install

Not published yet: install the tarballs produced by `pnpm build && pnpm test:pack`.
The future registry syntax, after owner-authorized publication, is:

```sh
npm install @nestvexa/realtime   # or: pnpm add / yarn add
# optional WebSocket transport
npm install ws
```

Peers: `@nestjs/common` and `@nestjs/core` 12, `reflect-metadata` 0.2, `rxjs` 7;
`ws` 8 (optional). No runtime dependencies. ESM only; Node 22.13+ or 24. The
browser side lives in `@nestvexa/client`; the Redis entry point for several
replicas is [`@nestvexa/realtime-redis`](../realtime-redis/README.md).

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

| Export                                                                     | Purpose                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `RealtimeModule.forRoot(options)` / `forRootAsync({ inject, useFactory })` | Registers `GET <endpoint>/sse` and `GET <endpoint>/poll` (default `/_nestvexa/realtime`) and a global `RealtimeService`                    |
| `RealtimeService.publish(channel, data?, { identity? })`                   | Invalidate subscribers; `data` is JSON ≤16 KiB; `identity` applies `publishesPerMinute`                                                    |
| `RealtimeService.presence(identity, channel)`                              | Distinct members for an authorized reader: this replica's, or every replica's with a `presence` store                                      |
| `RealtimeService.transports` / `GET <endpoint>/negotiate`                  | Transports offered now, in preference order (WebSocket only once attached); `auto` clients read it                                         |
| `MemoryPresenceStore`, `PresenceStore`                                     | Shared presence contract (`RedisPresenceStore` in `@nestvexa/realtime-redis/realtime`)                                                     |
| `RealtimeService.sign(identity, channels)`                                 | Token for authorized channels, or `undefined`                                                                                              |
| `RealtimeService.revoke(binding)` / `closeChannel(channel)`                | Close connections on logout or permission changes                                                                                          |
| `attachRealtimeWebSocket(app)`                                             | Optional `<endpoint>/ws` transport; requires `resolveUpgradeIdentity`; shares a port with a host `@WebSocketGateway` (`WsAdapter`)         |
| `RealtimeNotifications`, `MemoryNotificationStore`, `NotificationStore`    | User-scoped notifications with an unread count on a private `notify:<digest>` channel per recipient                                        |
| `MemoryRealtimeBroker`                                                     | Default single-process broker with bounded replay                                                                                          |
| `RespRealtimeBroker({ host, port, password?, prefix })`                    | Cross-replica pub/sub over the Redis protocol (`RedisRealtimeBroker` in `@nestvexa/realtime-redis/realtime`)                               |
| `JobRunner`, `MemoryJobQueue`, `JobQueue`                                  | Owner-bound named jobs with progress, idempotency keys, retries, cancellation and leases over a pluggable queue (durable: `RedisJobQueue`) |
| `createTokenSigner`, `RealtimeHub`                                         | Lower-level building blocks                                                                                                                |

Options: `secrets` (1–8, ≥32 bytes, first signs), `origin` (exact), `resolveIdentity`,
`authorizeChannel`, `describePresence?`, `resolveUpgradeIdentity?`, `broker?`,
`presence?` (`{ store, ttlMs? }`, default TTL 30 s), `transports?` (default
`['websocket', 'sse', 'polling']`; disabled routes answer 404),
`endpoint?`, `tokenTtlMs?` (default 15 min), `limits?` (`maxConnections` 1000,
`maxConnectionsPerIdentity` 8, `queueLimit` 1024, `maxQueuedBytes` 4 MiB,
`drainTimeoutMs` 10000, `heartbeatMs` 15000,
`revalidateMs` 30000, `subscribesPerMinute` 60, `publishesPerMinute` 120,
`maxPresenceMembers` 100), `instrumentation?` (structural tracing hook:
`nestvexa.realtime.publish`, `.subscribe`, `.connection` and `.deliver` spans
with transports, channel kinds, counts, sizes and rejection codes; never full
channel names, payloads, tokens or identities). The `auto` browser transport
negotiates with the server and falls back WebSocket → SSE → polling at runtime;
see the [realtime guide](../../docs/guides/realtime.md) for presence, rate
limits, jobs and multiple replicas.

Browser: `createLiveClient({ realtime: { endpoint, transport: 'auto' | 'sse' | 'websocket' | 'polling' } })`
or the umbrella `browser.realtime` option. A component can choose its own
transport with `@LiveComponent({ realtime: { transport } })`; the browser then
opens one connection per transport in use, and an `auto` component negotiates
and falls back on its own connection.

### Backpressure

Delivery is drain-aware. A write that leaves more than 256 KiB buffered on a
connection (SSE `writableLength`, WebSocket `bufferedAmount`) pauses that
connection: later events queue in order and are written once the transport
drains. The connection is closed as `slow-consumer` only when the transport
stays congested for `drainTimeoutMs`, or its queue exceeds `queueLimit`
events or `maxQueuedBytes`. A burst published in one event-loop turn
therefore reaches healthy subscribers in full, while a stalled client is
still cut off. Custom `RealtimeSink`s that do not implement `onDrain` are
closed as soon as `send` returns false.

### Notifications

```ts
const notifications = new RealtimeNotifications({
  publisher: realtimeService,
  recipient: (identity) => userIdOf(identity), // one inbox per user
});
// RealtimeModule: authorizeChannel: (identity, channel) =>
//   notifications.authorize(identity, channel) || otherRules(identity, channel)
await notifications.notify('user-42', {
  title: 'Invoice paid',
  data: { id: 7 },
});
await notifications.list(identity); // { unread, total, items }
await notifications.markRead(identity, [id]); // own inbox only
```

Every change publishes `{ nvNotifications: { unread, latest? } }` on the
recipient's channel (`notifications.channel(identity)`; subscribe a Live
component to it with `@RealtimeChannels`). Without `recipient`, the inbox key
is the kernel principal scoped to its tenant, or the session binding. The
default store is process-local; pass a shared `NotificationStore` for several
replicas.

## Security

- Knowing a channel name is not authorization: tokens are identity-bound and every
  channel is re-authorized at subscribe, periodically and before delivery.
- Tokens are signed, not encrypted; channel names are visible to the browser.
- SSE tokens travel in the query string; keep them out of shared access logs.
- WebSocket upgrades require the exact configured `Origin`.
- Slow consumers are disconnected rather than buffered without bound (drain
  timeout, queue event and byte bounds).
- Notification channels are digests of the recipient key and authorized only
  for that recipient's identities; reads and marks never cross inboxes.
- Pushed data is never applied as server state; components re-render through the
  normal Live security pipeline.

### Kernel identity and features

`kernelIdentity` (structural; `RequestContextFactory` from `@nestvexa/core`)
makes `RealtimeService.identity(request, resolver)` attach the kernel `principal`
and `tenant` to the identity `authorizeChannel` receives at connect and on every
revalidation (`revalidateMs`), and scope the binding to them, so a subscription
token signed for one user or tenant is refused (403) for another. A failing kernel
identity is `401 IDENTITY_REQUIRED`; host values for `principal`/`tenant` are
never kept. Enable it on Live too when Live signs tokens (both scope bindings
identically). `revoke(binding)` takes the binding the hub sees
(`identity.binding` in `authorizeChannel`). `featureRegistry`
(`NestvexaRegistry`) receives feature `realtime` with the `broker`, `websocket`,
`sse`, `polling`, `presence` and `kernel-identity` capabilities.

## Performance

Connections are bounded (`maxConnections` 1000, `maxConnectionsPerIdentity` 8),
each subscriber has a bounded queue (`queueLimit` 64) and slow consumers are
disconnected rather than buffered. The memory broker's replay history is bounded
(100 events per channel, 10,000 channels). A push is an invalidation: affected
components refresh through the normal Live request. `pnpm load` checks hub
memory under connection churn in one process; throughput across replicas with
Redis is not measured ([benchmarks](../../docs/testing/benchmarks.md)).

## Compatibility

- Node `^22.13.0 || ^24.0.0`, ESM only. Peers `@nestjs/common` and
  `@nestjs/core` ^12 (tested with 12.2.0); optional `ws` ^8.18.0 (tested with
  8.22.0) for WebSocket.
- Express and Fastify, single process and four replicas behind Redis 7
  (`examples/distributed-live`, `pnpm test:services`).
- Browser transports (SSE, WebSocket, long-polling) tested in Chromium,
  Firefox and WebKit (`tests/browser/realtime-transports.spec.ts`).

## Delivery semantics

At-most-once per connected subscriber. The memory broker replays the last 100
events per channel (`replaySize`) after reconnect, for at most 10,000 channels
(`replayChannels`; the least recently published channel's history is evicted
first, so per-user channel names cannot grow memory without bound); unknown or
evicted cursors replay nothing and clients refresh. Redis pub/sub is
fire-and-forget; `RespRealtimeBroker.subscribe` resolves after Redis confirms
the subscription. The default `MemoryJobQueue` keeps jobs in memory only
(`RedisJobQueue` is durable); replay windows are per replica, and presence is
per replica unless a `presence` store is configured. The unit tests use an
in-process RESP test double; `pnpm test:services`
([guide](../../docs/guides/production-services.md)) runs the broker, job queue
and presence store against real Redis (separate OS processes, a SIGKILLed
worker and replica, a Redis restart) and the multi-replica browser acceptance
suite of [`examples/distributed-live`](../../examples/distributed-live/README.md)
on Express and Fastify.
The in-process hub churn check in `pnpm load` covers single-replica memory.
`scripts/services-check.mjs` (section `redis-realtime-load`) runs many SSE
clients across two replicas over real Redis and reports delivery latency and
loss, without a pass threshold.

## Examples

[realtime-dashboard](../../examples/realtime-dashboard/README.md) (channels,
jobs with progress), [starter-live](../../examples/starter-live/README.md) and
[distributed-live](../../examples/distributed-live/README.md) (four replicas on
Express and Fastify, Redis, presence, SSE and WebSocket).

## Status and limits

Status: **Partial**. Authorized SSE, long-polling and WebSocket invalidation, presence, rate limits, the memory and Redis-protocol brokers and the job runner are implemented and tested, including a four-replica Express and Fastify browser run against Redis 7; the clauses below remain open.

- Presence is shared across replicas with a `presence` store; `redisRealtime()` from `@nestvexa/realtime-redis/realtime` configures `RedisPresenceStore` by default. `MemoryNotificationStore` is per replica; no Redis notification store ships (REAL-009).
- Events published on a channel before its subscription is established are not replayed (REAL-006).
- `MemoryJobQueue` (the default) loses jobs on restart; `RedisJobQueue` is durable. No BullMQ adapter ships; the reasons are in the realtime-redis README (DATA-010, DATA-011).
- The Redis broker implementation still lives in this package; `@nestvexa/realtime-redis/realtime` re-exports it, because moving it would create a package cycle (REAL-002, ADR 0032 round 10).
- The load section reports numbers but has no threshold, and is not a capacity benchmark (REAL-014).

## Testing

```sh
pnpm --filter @nestvexa/realtime test
pnpm build && pnpm exec vitest run tests/realtime.test.ts tests/realtime-hub.test.ts \
  tests/realtime-jobs.test.ts tests/realtime-live.test.ts tests/client-realtime.test.ts \
  tests/realtime-job-queue.test.ts tests/realtime-distributed.test.ts \
  tests/realtime-backpressure.test.ts tests/realtime-notifications.test.ts
pnpm exec playwright test tests/browser/realtime.spec.ts tests/browser/realtime-transports.spec.ts
NESTVEXA_REDIS_PORT=6379 pnpm test:services
```

Runs `tests/realtime.test.ts` and `tests/realtime-*.test.ts` (hub, jobs, Live integration) with the root Vitest config against an in-process RESP test double; the tests import `packages/*/dist`, so run `pnpm --filter @nestvexa/realtime... build` first. Run separately: the browser controller in `tests/client-realtime.test.ts`, the token property tests (`pnpm test:property`), the browser specs `tests/browser/realtime.spec.ts`, `realtime-transports.spec.ts` and `realtime-dashboard.spec.ts` (`pnpm test:e2e`), and `NESTVEXA_REDIS_PORT=6379 pnpm test:services`, which runs the broker, job queue and presence store against real Redis (separate OS processes, Redis restart) and the four-replica browser suite ([guide](../../docs/guides/production-services.md)). See the [realtime guide](../../docs/guides/realtime.md) and [ADR 0009](../../docs/adr/0009-realtime-backpressure.md). License: MIT.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
