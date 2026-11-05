# Multiple replicas and Redis

You can run several Nestvexa processes behind one load balancer, but only if
you know which state each process keeps for itself. The short version: **Live
state and upload sessions are per process, so replicas need sticky
sessions.** Redis, through `RespRealtimeBroker`, carries realtime
invalidation events between replicas. It shares nothing else.

> **Known gap:** No test has run two Nest replicas serving one browser through
> Redis. `pnpm test:services` verified `RespRealtimeBroker` against Redis 7 on
> 2026-11-02. An event published in one Node process reached a subscriber in a
> second process, and delivery resumed after a Redis restart. Multi-replica
> topologies, cross-replica tenant isolation and load behavior are unverified
> (ledger rows REAL-008 and REAL-014). The recommendations below follow from
> the code, not from an executed multi-replica deployment.

## What lives where

| State                                 | Implementation                               | Shareable across replicas?                                                                                                                 |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Live component state and snapshots    | `MemoryLiveStore`                            | **No.** The Live runtime accepts only a `MemoryLiveStore` instance. There is no pluggable or Redis-backed store yet.                       |
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

## Sticky sessions are required for Live and uploads

Suppose a page was mounted on replica A and its next action reaches replica B.
B has no entry for that snapshot token and answers `410` ("Live state is
unavailable; reload the page"). Upload chunk and finalize requests behave the
same way: the session or token is unknown (`404`). So:

- Route each browser session to one replica, for example with a cookie-based
  affinity at the load balancer. IP-hash affinity breaks when client addresses
  change.
- Expect users on a replica that is removed or restarted to reload. Their
  Live state is gone and in-progress uploads are lost.
- Drain replicas before you stop them. Remove a replica from the pool, wait
  for in-flight requests and the Live state TTL (15 minutes by default) if you
  can, then send `SIGTERM`.

Affinity does not make a deployment highly available for Live state. It only
makes it consistent. A distributed Live store is tracked as ledger rows
DATA-004 and DATA-005.

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
connection on another replica. Periodic revalidation has no dedicated test yet
(ledger row REAL-005).

> **Known gap:** Presence, per-component transport selection and runtime
> transport fallback are not implemented. Publish-rate limiting is not
> implemented either: only connection caps and per-connection queue limits
> exist (ledger rows REAL-004, REAL-009 and REAL-011).

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

- [ ] Sticky sessions keyed on the session cookie.
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
