# @nestvexa/realtime-redis

Optional Redis adapters for running Nestvexa on several replicas: a shared Live
state store (`RedisLiveStore`), cross-instance realtime pub/sub
(`RedisRealtimeBroker`), shared presence (`RedisPresenceStore`) and a durable
job queue (`RedisJobQueue`). All speak RESP2 over `node:net`; there is no Redis
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
import {
  RedisJobQueue,
  RedisPresenceStore,
  RedisRealtimeBroker,
} from '@nestvexa/realtime-redis/realtime';

const redis = {
  host: 'redis',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
};

RealtimeModule.forRoot({
  ...realtimeOptions,
  broker: new RedisRealtimeBroker({ ...redis, prefix: 'shop:prod:rt:' }),
  presence: {
    store: new RedisPresenceStore({ ...redis, prefix: 'shop:prod:presence:' }),
  },
});
const jobs = new JobRunner({
  queue: new RedisJobQueue({ ...redis, prefix: 'shop:prod:jobs:' }),
  notify: (channel, job) => realtime.publish(channel, { status: job.status }),
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
[distributed example](../../examples/distributed-live) runs replicas on Express
and Fastify behind one Redis.

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
  action deadline plus one second (300 s without a deadline). Both are checked
  against real Redis by `pnpm test:services`, with two store instances and in
  the four-replica browser suite (Express and Fastify replicas).

Cost: about seven round trips per Live action (read, lease, re-read, watched
commit). Clocks of all replicas must be NTP-synchronized.

## Realtime

`RedisRealtimeBroker` is `RespRealtimeBroker` from `@nestvexa/realtime`
(PUBLISH/SUBSCRIBE, automatic resubscription with backoff). Delivery is
at-most-once per connected subscriber: events published while a replica is
disconnected from Redis are lost and browsers recover with an authorized
refresh. Replay windows are per replica.

## Presence

`RedisPresenceStore` implements `PresenceStore` from `@nestvexa/realtime`.
Each replica writes its members per channel to
`<prefix>pm:<replica>:<channel>` with a Redis expiry (`PX`, the module's
presence `ttlMs`, default 30 s) and rewrites it every third of the TTL; the set
`<prefix>pr:<channel>` names candidate replicas and is pruned on read. A
replica that exits gracefully removes its entries; one that crashes drops out
when its key expires. Entries hold public descriptors only (never bindings) and
are re-validated by every reader. Cost: one `SET` + `SADD` + `PEXPIRE` per
presence change and per channel per heartbeat; one `SMEMBERS` plus a `GET` per
replica per `presence()` call.

## Durable jobs

`RedisJobQueue` implements `JobQueue` for `JobRunner`, so jobs survive
restarts and any worker can run them:

- `<prefix>j:<id>` holds the record (validated on every read; a tampered record
  is never shown, authorized or executed); sorted sets `queued` (by creation),
  `running` (by lease expiry) and `done` (by finish time) index work, crash
  recovery and retention; `<prefix>k:<sha256>` maps an owner-scoped idempotency
  key to its job.
- Every change is a `WATCH`/`MULTI`/`EXEC` compare-and-set on the job record:
  one worker holds a lease at a time and a worker that lost its lease cannot
  write. Racing claimants get distinct jobs.
- At-least-once: a job whose worker died (no lease renewal) is claimed again
  once its lease lapses, with `attempts` incremented; handlers must be
  idempotent. A graceful `JobRunner.close()` hands running jobs back at once.
- Cost: claim/update/cancel are about five round trips each and are serialized
  per queue instance on one transaction connection. Progress updates go through
  the same path, so report coarse progress.

| Option                                             | Default          | Meaning                               |
| -------------------------------------------------- | ---------------- | ------------------------------------- |
| `host`, `port`, `username`, `password`, `database` | as above         | Redis primary                         |
| `prefix`                                           | `nestvexa:jobs:` | Key namespace (`[a-z0-9:._-]{0,64}`)  |
| `commandTimeoutMs`                                 | 5000             | Per-command timeout; failures surface |

**BullMQ.** No BullMQ adapter ships. `JobQueue` is a storage contract (claim,
lease-conditional update, cancel flag); BullMQ owns its worker loop, locks,
retries and backoff, and has no cooperative cancellation of active jobs, so an
adapter would either bypass BullMQ's processing model or not satisfy the
contract (cross-worker cancel, owner-scoped idempotency, lease-checked writes).
It would also pull `bullmq` and `ioredis` into the install. Use
`RedisJobQueue`, or run BullMQ directly (the realtime guide shows how to publish
its progress to `job:<id>` channels).

## Status and limits

Status: **Shipped (alpha)**. `RedisLiveStore` passes the shared store contract suite and, with the realtime broker, a real Redis 7 run including the four-replica (Express and Fastify) browser acceptance suite ([services evidence](../../docs/implementation/services-evidence-2026-11-05.json)).

- Single Redis primary only; no Sentinel discovery or tested failover, and Redis Cluster is not supported (DATA-004).
- Cross-replica idempotent replay and identity locks are covered by the real-Redis service run (`redis-live-coordination`, PROT-017).
- The broker implementation lives in `@nestvexa/realtime`; this package re-exports it (REAL-002, recorded in ADR 0032).
- Realtime delivery is at-most-once and replay windows are per replica; presence is shared through `RedisPresenceStore`. Distributed load testing is not done (REAL-014).
- About seven round trips per Live action; replica clocks must be NTP-synchronized.

## Testing

```sh
pnpm --filter @nestvexa/realtime-redis test
pnpm exec vitest run tests/live-store-contract.test.ts tests/realtime-job-queue.test.ts \
  tests/realtime-distributed.test.ts                       # RESP test double
pnpm exec vitest run tests/live-shared-action-policy.test.ts
NESTVEXA_REDIS_PORT=6379 pnpm test:services                # real Redis
```

Runs `tests/live-store-contract.test.ts` and `tests/live-shared-action-policy.test.ts` with the root Vitest config against an in-process RESP test double; the tests import `packages/*/dist`, so run `pnpm --filter @nestvexa/realtime-redis... build` first. `NESTVEXA_REDIS_PORT=6379 pnpm test:services` runs the store and broker against real Redis plus the two-replica browser suite, separately from the package script.

See [ADR 0032](../../docs/adr/0032-distributed-state-and-redis.md) and the
[production services guide](../../docs/guides/production-services.md). License: MIT.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
