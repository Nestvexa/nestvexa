# @nestvexa/realtime-redis

Optional Redis adapters for running Nestvexa on several replicas: a shared Live
state store (`RedisLiveStore`) and cross-instance realtime pub/sub
(`RedisRealtimeBroker`). Both speak RESP2 over `node:net`; there is no Redis
client library dependency. Not part of the default `nestvexa` install.

## Install

Not published yet: install the tarballs produced by `pnpm build && pnpm test:pack`.
The future registry syntax, after owner-authorized publication, is:

```sh
npm install @nestvexa/realtime-redis   # or: pnpm add / yarn add
```

Peers: `@nestvexa/live` (required) and `@nestvexa/realtime` (optional, for the
`/realtime` entry point). Node 22.13+ or 24. Server: Redis 6.2+ (tested with
Redis 7 standalone) as a single primary. There is no Sentinel discovery: point
`host` at the current primary; failover behavior is untested. **Redis Cluster
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
[distributed example](../../examples/distributed-live/README.md) runs two replicas behind
one Redis.

## Public API

| Export                                                         | Purpose                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `RedisLiveStore`, `RedisLiveStoreOptions`                      | `LiveStateStore` and `LiveActionCoordination` over one Redis primary                  |
| `RedisRealtimeBroker`, `RedisRealtimeBrokerOptions`            | From `@nestvexa/realtime-redis/realtime`; re-export of `RespRealtimeBroker`           |
| `RespConnection`, `RespError`, `encodeCommand`, `parseReplies` | Low-level RESP2 client used by the store (`RespConnectionOptions`, `RespReply` types) |

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
- The store also implements `LiveActionCoordination`, so `@Action({ idempotent })`
  replays and `@Action({ concurrency: 'identity' })` locks work across replicas:
  replay records (`<prefix>r:<digest>`) are AES-256-GCM ciphertext sealed by Live
  with a key the store never sees; identity locks are `SET NX PX` leases
  (`<prefix>a:<digest>`) released by compare-and-delete and expiring after the
  action deadline plus one second (300 s without a deadline).

Cost: about seven round trips per Live action (read, lease, re-read, watched
commit). Clocks of all replicas must be NTP-synchronized.

## Realtime

`RedisRealtimeBroker` is `RespRealtimeBroker` from `@nestvexa/realtime`
(PUBLISH/SUBSCRIBE, automatic resubscription with backoff). Delivery is
at-most-once per connected subscriber: events published while a replica is
disconnected from Redis are lost and browsers recover with an authorized
refresh. Replay windows are per replica.

## Status and limits

Status: **Shipped (alpha)**. `RedisLiveStore` passes the shared store contract suite and, with the realtime broker, a real Redis 7 run including the two-replica browser acceptance suite ([services evidence](../../docs/implementation/services-evidence-2026-11-05.json)).

- Single Redis primary only; no Sentinel discovery or tested failover, and Redis Cluster is not supported (DATA-004).
- Cross-replica idempotent replay and identity locks are tested against the in-process RESP test double; the real-Redis service run does not cover them yet (LIVE-007).
- The broker implementation lives in `@nestvexa/realtime`; this package re-exports it (REAL-002, recorded in ADR 0032).
- Realtime delivery is at-most-once, presence and replay windows are per replica, and browser reconnect across a replica restart is unit-tested only (REAL-014).
- About seven round trips per Live action; replica clocks must be NTP-synchronized.

## Testing

```sh
pnpm --filter @nestvexa/realtime-redis test
```

Runs `tests/live-store-contract.test.ts` and `tests/live-shared-action-policy.test.ts` with the root Vitest config against an in-process RESP test double; the tests import `packages/*/dist`, so run `pnpm --filter @nestvexa/realtime-redis... build` first. `NESTVEXA_REDIS_PORT=6379 pnpm test:services` runs the store and broker against real Redis plus the two-replica browser suite, separately from the package script.

See [ADR 0032](../../docs/adr/0032-distributed-state-and-redis.md) and the
[production services guide](../../docs/guides/production-services.md). License: MIT.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
