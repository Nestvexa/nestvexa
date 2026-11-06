# @nestvexa/realtime-redis

Optional Redis adapters for running Nestvexa on several replicas: a shared Live
state store (`RedisLiveStore`) and cross-instance realtime pub/sub
(`RedisRealtimeBroker`). Both speak RESP2 over `node:net`; there is no Redis
client library dependency. Not part of the default `nestvexa` install.

## Install

```sh
npm install @nestvexa/realtime-redis
```

Peers: `@nestvexa/live` (required) and `@nestvexa/realtime` (optional, for the
`/realtime` entry point). Node 22.13+ or 24. Server: Redis 6.2+ (tested with
Redis 7) as a single primary — standalone or Sentinel-managed. **Redis Cluster
is not supported** (commits span hash slots).

## Usage

```ts
import { RedisLiveStore } from '@nestvexa/realtime-redis';
import { RedisRealtimeBroker } from '@nestvexa/realtime-redis/realtime';

const redis = {
  host: 'redis',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
};

RealtimeModule.forRoot({
  ...realtimeOptions,
  broker: new RedisRealtimeBroker({ ...redis, prefix: 'shop:prod:rt:' }),
});
NestvexaModule.forRoot(config, {
  components,
  useFactory: () => ({
    ...livePolicies,
    store: new RedisLiveStore({ ...redis, prefix: 'shop:prod:live:' }),
  }),
});
```

Every replica must share the realtime `secrets`, the public `origin` and an
identity that resolves identically on every replica (a shared session store or
a signed stateless cookie). The
[distributed example](../../examples/distributed-live) runs two replicas behind
one Redis.

## `RedisLiveStore` options

| Option                             | Default          | Meaning                                                                       |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `host`, `port`                     | `127.0.0.1:6379` | Redis primary                                                                 |
| `username`, `password`, `database` | —, —, `0`        | ACL user, AUTH password (never logged), logical database                      |
| `prefix`                           | `nestvexa:live:` | Key namespace per application/environment (`[a-z0-9:._-]{0,64}`)              |
| `ttlMs`                            | 15 min           | Entry lifetime from creation (Redis `PX` and stored `expiresAt`)              |
| `lockTtlMs`                        | 30 s             | Transaction lease; an action outliving it fails closed (state invalidated)    |
| `maxEntriesPerBinding`             | 1000             | Entries one identity may hold (approximate; dead index members pruned lazily) |
| `maxInFlight`                      | 1000             | Concurrent transactions in this process                                       |
| `encryptionKeys`                   | none             | AES-256-GCM keys (32 bytes); first encrypts, all decrypt; plaintext rejected  |
| `commandTimeoutMs`                 | 5000             | A command without a reply destroys the connection and fails pending commands  |

## Semantics

Same contract as `MemoryLiveStore` (see `LiveStateStore` in `@nestvexa/live`):

- Entries are bound to the identity binding: another binding, an unknown,
  expired, malformed or tampered entry all fail as `INVALID_SNAPSHOT` (410).
- `transaction` rejects stale revisions and replays (409 `STALE_REVISION`) and
  concurrent actions on any replica (409 `COMPONENT_BUSY`, via a `SET NX PX`
  lease) before running the action, and commits with `WATCH`/`MULTI`/`EXEC`.
- A failed action, a revoke/delete during the action or an expired lease
  invalidates the entry instead of allowing a retry.
- Keys contain SHA-256 hashes of snapshot tokens and bindings, never the raw
  values. Records are validated on read with the browser-input limits.
- A Redis outage surfaces as an error (HTTP 500), never as missing state.
- `close()` (called on Nest shutdown) closes connections; shared state stays for
  the other replicas.

Cost: about seven round trips per Live action (read, lease, re-read, watched
commit). Clocks of all replicas must be NTP-synchronized.

## Realtime

`RedisRealtimeBroker` is `RespRealtimeBroker` from `@nestvexa/realtime`
(PUBLISH/SUBSCRIBE, automatic resubscription with backoff). Delivery is
at-most-once per connected subscriber: events published while a replica is
disconnected from Redis are lost and browsers recover with an authorized
refresh. Replay windows are per replica.

## Testing

```sh
pnpm exec vitest run tests/live-store-contract.test.ts   # RESP test double
NESTVEXA_REDIS_PORT=6379 pnpm test:services                # real Redis
```

See [ADR 0027](../../docs/adr/0027-distributed-state-and-redis.md) and the
[production services guide](../../docs/guides/production-services.md). License: MIT.
