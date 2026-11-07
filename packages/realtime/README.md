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

| Export                                                                     | Purpose                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `RealtimeModule.forRoot(options)` / `forRootAsync({ inject, useFactory })` | Registers `GET <endpoint>/sse` and `GET <endpoint>/poll` (default `/_nestvexa/realtime`) and a global `RealtimeService` |
| `RealtimeService.publish(channel, data?, { identity? })`                   | Invalidate subscribers; `data` is JSON ≤16 KiB; `identity` applies `publishesPerMinute`                                 |
| `RealtimeService.presence(identity, channel)`                              | Distinct members connected to this replica, for an authorized reader                                                    |
| `RealtimeService.sign(identity, channels)`                                 | Token for authorized channels, or `undefined`                                                                           |
| `RealtimeService.revoke(binding)` / `closeChannel(channel)`                | Close connections on logout or permission changes                                                                       |
| `attachRealtimeWebSocket(app)`                                             | Optional `<endpoint>/ws` transport; requires `resolveUpgradeIdentity`                                                   |
| `MemoryRealtimeBroker`                                                     | Default single-process broker with bounded replay                                                                       |
| `RespRealtimeBroker({ host, port, password?, prefix })`                    | Cross-replica pub/sub over the Redis protocol (`RedisRealtimeBroker` in `@nestvexa/realtime-redis/realtime`)            |
| `JobRunner`, `MemoryJobQueue`, `JobQueue`                                  | Owner-bound named jobs with progress, idempotency keys, retries, cancellation and leases over a pluggable queue         |
| `createTokenSigner`, `RealtimeHub`                                         | Lower-level building blocks                                                                                             |

Options: `secrets` (1–8, ≥32 bytes, first signs), `origin` (exact), `resolveIdentity`,
`authorizeChannel`, `describePresence?`, `resolveUpgradeIdentity?`, `broker?`,
`endpoint?`, `tokenTtlMs?` (default 15 min), `limits?` (`maxConnections` 1000,
`maxConnectionsPerIdentity` 8, `queueLimit` 64, `heartbeatMs` 15000,
`revalidateMs` 30000, `subscribesPerMinute` 60, `publishesPerMinute` 120,
`maxPresenceMembers` 100), `instrumentation?` (structural tracing hook:
`nestvexa.realtime.publish`, `.subscribe`, `.connection` and `.deliver` spans
with transports, channel kinds, counts, sizes and rejection codes; never full
channel names, payloads, tokens or identities). `auto` transport falls back from SSE to long-polling
at runtime; see the [realtime guide](../../docs/guides/realtime.md) for presence,
rate limits, jobs (including a BullMQ adapter recipe) and multiple replicas.

Browser: `createLiveClient({ realtime: { endpoint, transport: 'auto' | 'sse' | 'websocket' | 'polling' } })`
or the umbrella `browser.realtime` option.

## Security

- Knowing a channel name is not authorization: tokens are identity-bound and every
  channel is re-authorized at subscribe, periodically and before delivery.
- Tokens are signed, not encrypted; channel names are visible to the browser.
- SSE tokens travel in the query string; keep them out of shared access logs.
- WebSocket upgrades require the exact configured `Origin`.
- Slow consumers are disconnected rather than buffered without bound.
- Pushed data is never applied as server state; components re-render through the
  normal Live security pipeline.

## Delivery semantics

At-most-once per connected subscriber. The memory broker replays the last 100
events per channel (`replaySize`) after reconnect, for at most 10,000 channels
(`replayChannels`; the least recently published channel's history is evicted
first, so per-user channel names cannot grow memory without bound); unknown or
evicted cursors replay nothing and clients refresh. Redis pub/sub is
fire-and-forget. The default `MemoryJobQueue` keeps jobs in memory only;
presence and replay windows are per replica.

## Examples

[realtime-dashboard](../../examples/realtime-dashboard/README.md) (channels,
jobs with progress), [starter-live](../../examples/starter-live/README.md) and
[distributed-live](../../examples/distributed-live/README.md) (two replicas and
Redis, presence, SSE and WebSocket).

## Status and limits

Status: **Partial**. Authorized SSE, long-polling and WebSocket invalidation, presence, rate limits, the memory and Redis-protocol brokers and the job runner are implemented and tested, including a two-replica browser run against Redis 7; the clauses below remain open.

- Transport is chosen per app/client, not per component, and `auto` falls back from SSE to polling but never tries WebSocket (REAL-004).
- Presence counts members connected to one replica; there is no cross-replica aggregation and no dedicated notification/dashboard primitive (REAL-009).
- Events published on a channel before its subscription is established are not replayed (REAL-006).
- No durable job queue ships: `MemoryJobQueue` loses jobs on restart and BullMQ is a documented recipe only (DATA-010, DATA-011).
- The Redis broker implementation still lives in this package; `@nestvexa/realtime-redis/realtime` re-exports it (REAL-002, ADR 0032).
- Browser reconnect and deduplication across a replica restart, subscription-leak and slow-client checks are unit-tested at hub level only; the two-replica suite runs on Express only, and distributed load testing is not done (REAL-014).

## Testing

```sh
pnpm --filter @nestvexa/realtime test
```

Runs `tests/realtime.test.ts` and `tests/realtime-*.test.ts` (hub, jobs, Live integration) with the root Vitest config against an in-process RESP test double; the tests import `packages/*/dist`, so run `pnpm --filter @nestvexa/realtime... build` first. Run separately: the browser controller in `tests/client-realtime.test.ts`, the token property tests (`pnpm test:property`), the browser specs `tests/browser/realtime.spec.ts`, `realtime-transports.spec.ts` and `realtime-dashboard.spec.ts` (`pnpm test:e2e`), and `NESTVEXA_REDIS_PORT=6379 pnpm test:services`, which runs the broker against real Redis (two OS processes, Redis restart) and the two-replica browser suite ([guide](../../docs/guides/production-services.md)). See the [realtime guide](../../docs/guides/realtime.md) and [ADR 0009](../../docs/adr/0009-realtime-backpressure.md). License: MIT.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
