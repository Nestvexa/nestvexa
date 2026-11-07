# Multiple replicas and Redis

You can run several Nestvexa processes behind one load balancer, but only if
you know which state each process keeps for itself. The short version: with
`@nestvexa/realtime-redis`, **Live state and realtime events are shared through
Redis**, so a Live component mounted on one replica continues on another.
**Upload sessions stay per process**, so upload routes still need sticky
sessions or a single upload node.

`pnpm test:services` ran against Redis 7 on 2026-11-05
([evidence](../implementation/services-evidence-2026-11-05.json)). It covers
cross-process publish and resubscription after a Redis restart, `RedisLiveStore`
continuation, replay and binding rejection, leases and TTLs, and a two-replica
browser suite. In that suite a publish on replica B refreshes a browser on
replica A over SSE (and back over WebSocket), Live state created on A continues
on B, and identities stay isolated on both replicas. The
[distributed example](../../examples/distributed-live/README.md) runs that
topology.

> **Known gap:** only a single Redis primary is supported. There is no Sentinel
> discovery or tested failover, and Redis Cluster is not supported (DATA-004).
> Cross-replica idempotent replay and identity locks are tested against the
> in-process RESP test double only (LIVE-007). Load behavior is unverified, and
> the two-replica suite runs on Express only (REAL-014).

## What lives where

| State                                 | Implementation                               | Shareable across replicas?                                                                                                                 |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Live component state and snapshots    | `LiveStore` (`MemoryLiveStore` by default)   | **Yes,** with `RedisLiveStore` from `@nestvexa/realtime-redis`. `MemoryLiveStore` stays inside one process.                                |
| Live rate limiting                    | Per process, per binding (default 60/min)    | No. The effective limit is multiplied by the replica count.                                                                                |
| Upload sessions and pending tokens    | `UploadsService` memory                      | **No.** Temporary chunks are on local disk. Finalized objects can live in shared storage (`S3Storage`).                                    |
| Realtime events                       | `RealtimeBroker` interface                   | **Yes,** with `RespRealtimeBroker`. The default `MemoryRealtimeBroker` stays inside one process.                                           |
| Realtime subscription tokens          | HMAC with `RealtimeModule` `secrets`         | Yes, if every replica uses the same `secrets`. Tokens signed on one replica are then valid on another.                                     |
| Jobs and progress                     | `JobRunner` (in process, lost on restart)    | No. Use a durable queue for real work. No BullMQ adapter ships.                                                                            |
| Cache                                 | `Cache` + `CacheStore` interface             | `MemoryCacheStore` is per process. Implement `CacheStore` against a shared store yourself and invalidate across replicas through realtime. |
| Action idempotency                    | `ActionIdempotencyStore` interface           | `MemoryIdempotencyStore` is per process. The interface lets you supply a shared implementation.                                            |
| Form drafts / no-JS submission ledger | `DraftStore` / `SubmissionLedger` interfaces | The `Memory*` implementations are per process. Supply shared implementations for several replicas.                                         |
| HTTP sessions                         | Host-owned (`express-session` in examples)   | The host chooses a shared session store.                                                                                                   |

Nestvexa does not ship Redis implementations of `CacheStore`,
`ActionIdempotencyStore`, `DraftStore` or `SubmissionLedger`. The interfaces
are exported so that you can write them.

## Shared Live state

Pass a `RedisLiveStore` as the Live `store`. Every replica must use the same
`prefix`, the same realtime `secrets` and `origin`, and an identity that resolves
identically everywhere (a shared session store or a signed stateless cookie):

```ts
import { RedisLiveStore } from '@nestvexa/realtime-redis';

NestvexaModule.forRoot(config, {
  components,
  useFactory: () => ({
    ...livePolicies,
    store: new RedisLiveStore({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: 6379,
      prefix: 'myapp:live:',
    }),
  }),
});
```

`livePolicies` holds your `resolveIdentity` and `authorize` callbacks. Options,
encryption keys and the transaction lease are documented in the
[package README](../../packages/realtime-redis/README.md). Each Live action takes
about seven Redis round trips, and replica clocks must be NTP-synchronized. A
`download` URL created by a replayed action is served only by the replica that
created it.

## Sticky sessions are still required for uploads (and for the memory store)

With `MemoryLiveStore`, a page mounted on replica A whose next action reaches
replica B gets `410` ("Live state is unavailable; reload the page"). Upload chunk
and finalize requests behave the same way with any Live store: the session or
token is unknown on another replica (`404`). So:

- Route each browser session to one replica, for example with a cookie-based
  affinity at the load balancer. IP-hash affinity breaks when client addresses
  change.
- Expect users on a replica that is removed or restarted to reload. Their
  Live state is gone and in-progress uploads are lost.
- Drain replicas before you stop them. Remove a replica from the pool, wait
  for in-flight requests and the Live state TTL (15 minutes by default) if you
  can, then send `SIGTERM`.

Affinity does not make a deployment highly available. It only makes it
consistent. With `RedisLiveStore`, Live state survives the loss of a replica,
but in-progress uploads do not.

## Realtime across replicas

Realtime is the one subsystem built for several replicas. Publishing on any
replica must refresh subscribers connected to other replicas:

```ts
import { RealtimeModule, RespRealtimeBroker } from '@nestvexa/realtime';

RealtimeModule.forRoot({
  secrets: [process.env.REALTIME_SECRET ?? ''], // same value on every replica
  origin: 'https://app.example.com',
  broker: new RespRealtimeBroker({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: 6379,
    ...(process.env.REDIS_PASSWORD
      ? { password: process.env.REDIS_PASSWORD }
      : {}),
    prefix: 'myapp:', // isolates channels on a shared Redis
  }),
  resolveIdentity: (request) => ({ binding: sessionBinding(request) }),
  authorizeChannel: (identity, channel) => policies.canRead(identity, channel),
});
```

`sessionBinding` and `policies` belong to your application. `RespRealtimeBroker`
uses the Redis protocol's `PUBLISH`/`SUBSCRIBE` over a plain socket. It needs
no Redis client library. It does not configure TLS, so keep Redis on a private
network.

Delivery semantics:

- **At most once.** Redis pub/sub is fire-and-forget. Events published while a
  replica is disconnected from Redis are lost for that replica's subscribers.
  The broker reconnects with bounded backoff and restores its subscriptions.
  Browsers refresh authoritative state after they reconnect.
- **Invalidation only.** A pushed event makes each subscribed component
  re-render through its own authorized `$sync` route on the replica holding
  its state. Event `data` (at most 16 KiB of JSON) is never applied as state.
- **Replay is local.** The bounded replay window (last 100 events per channel)
  lives in each replica's local broker. A browser that reconnects to a
  different replica may get no replay and refreshes instead.

`RealtimeService.revoke(binding)` and `closeChannel(channel)` act on
connections held by the replica where you call them. Revocation is not
broadcast across replicas. On every replica, each connection is revalidated
periodically (`limits.revalidateMs`, default 30 s). Revalidation resolves the
identity again and re-authorizes each channel. If your shared session store
and channel policy reflect the logout or permission change, the connection
closes within that interval. Until then, a revoked identity can keep a
connection on another replica. Periodic revalidation is covered by
`tests/realtime-hub.test.ts` on one hub, not across replicas.

Presence (`RealtimeService.presence`) and the subscribe and publish rate limits
(`subscribesPerMinute`, `publishesPerMinute`) are enforced per replica.

> **Known gap:** presence counts only members connected to the replica you ask,
> with no cross-replica aggregation (REAL-009). The transport is chosen per app,
> not per component, and `auto` falls back from SSE to polling but never tries
> WebSocket (REAL-004).

## Cache invalidation across replicas

`Cache#invalidate(tags)` deletes entries in its own store and calls the
`onInvalidate` hook. To invalidate other replicas, publish
`tagChannel(tag)` from that hook through a `RealtimeService` backed by
`RespRealtimeBroker`. Components that declare the same channels in
`@RealtimeChannels()` then refresh. The cache package wires none of this
automatically. An end-to-end test of cache invalidation through realtime to a
component refresh does not exist yet (ledger row REAL-010). See the
[cache package](../../packages/cache/README.md).

## Checklist

- [ ] `RedisLiveStore` with a unique `prefix` for Live state, or sticky
      sessions with `MemoryLiveStore`.
- [ ] Sticky sessions keyed on the session cookie for upload routes.
- [ ] Shared HTTP session store, chosen and operated by the host.
- [ ] Identical `RealtimeModule` `secrets` and `origin` on every replica.
- [ ] `RespRealtimeBroker` with a unique `prefix`, Redis on a private
      network, password from the environment.
- [ ] `S3Storage` (or another shared `UploadStorage`) for finalized uploads.
      Each replica keeps its own local temporary `directory`.
- [ ] A durable queue instead of `JobRunner` for work that must survive restarts.
- [ ] Shared implementations of `CacheStore`, `ActionIdempotencyStore`,
      `DraftStore` and `SubmissionLedger` where you use those features.
- [ ] Drain replicas before you stop them, and plan for users reloading after
      a deploy.

Further reading: [realtime guide](../guides/realtime.md),
[ADR 0009](../adr/0009-realtime-backpressure.md),
[production services](../guides/production-services.md) and
[uploads](../../packages/uploads/README.md).
