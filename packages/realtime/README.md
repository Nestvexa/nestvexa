# @nestvexa/realtime

Authorized realtime invalidation for Nestvexa Live components: Server-Sent Events,
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
| `RealtimeService.publish(channel, data?)`                                  | Invalidate subscribers; `data` is JSON ≤16 KiB                                                                          |
| `RealtimeService.sign(identity, channels)`                                 | Token for authorized channels, or `undefined`                                                                           |
| `RealtimeService.revoke(binding)` / `closeChannel(channel)`                | Close connections on logout or permission changes                                                                       |
| `attachRealtimeWebSocket(app)`                                             | Optional `<endpoint>/ws` transport; requires `resolveUpgradeIdentity`                                                   |
| `MemoryRealtimeBroker`                                                     | Default single-process broker with bounded replay                                                                       |
| `RespRealtimeBroker({ host, port, password?, prefix })`                    | Cross-replica pub/sub over the Redis protocol                                                                           |
| `JobRunner`                                                                | In-process owner-bound jobs with progress, retries and cancellation                                                     |
| `createTokenSigner`, `RealtimeHub`                                         | Lower-level building blocks                                                                                             |

Options: `secrets` (1–8, ≥32 bytes, first signs), `origin` (exact), `resolveIdentity`,
`authorizeChannel`, `resolveUpgradeIdentity?`, `broker?`, `endpoint?`, `tokenTtlMs?`
(default 15 min), `limits?` (`maxConnections` 1000, `maxConnectionsPerIdentity` 8,
`queueLimit` 64, `heartbeatMs` 15000, `revalidateMs` 30000).

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

## Delivery semantics and limits

At-most-once per connected subscriber. The memory broker replays the last 100
events per channel after reconnect; unknown cursors replay nothing and clients
refresh. Redis pub/sub is fire-and-forget. `JobRunner` keeps jobs in memory only.
The unit tests use an in-process RESP test double. `pnpm test:services`
([guide](../../docs/guides/production-services.md)) also ran `RespRealtimeBroker` against Redis 7 on 2026-11-02:
delivery from one OS process to another, and resubscription after a Redis
restart. Not yet verified: two Nest replicas serving one browser through Redis,
and load testing.

## Testing

```sh
pnpm build && pnpm vitest run tests/realtime.test.ts tests/realtime-live.test.ts
pnpm exec playwright test tests/browser/realtime.spec.ts
```

See the [realtime guide](../../docs/guides/realtime.md) and
[ADR 0009](../../docs/adr/0009-realtime-backpressure.md). License: MIT.
