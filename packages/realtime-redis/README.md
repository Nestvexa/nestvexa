# @nestvexa/realtime-redis

Optional Redis adapters for running Nestvexa on several replicas: a shared Live
state store (`RedisLiveStore`), a shared server-action idempotency store
(`RedisActionIdempotencyStore`), a shared cache store (`RedisCacheStore`),
cross-instance realtime pub/sub (`RedisRealtimeBroker`), shared presence
(`RedisPresenceStore`) and a durable job queue (`RedisJobQueue`). All speak RESP2 over `node:net`; there is no Redis
client library dependency. Not part of the default `nestvexa` install.

## Install

Not published yet: install the tarballs produced by `pnpm build && pnpm test:pack`.
The future registry syntax, after owner-authorized publication, is:

```sh
npm install @nestvexa/realtime-redis   # or: pnpm add / yarn add
```

Peers, all optional, one per entry point: `@nestvexa/live` (the root entry,
`RedisLiveStore`), `@nestvexa/realtime` (`/realtime`), `@nestvexa/actions`
(`/actions`, types only) and `@nestvexa/cache` (`/cache`). The `/actions` and
`/cache` entry points never load `@nestvexa/live`. Node 22.13+ or 24. Server: Redis 6.2+ (tested with
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

### Server-action idempotency

```ts
import { RedisActionIdempotencyStore } from '@nestvexa/realtime-redis/actions';

ActionsModule.register({
  ...actionOptions,
  idempotency: {
    store: new RedisActionIdempotencyStore({
      ...redis,
      prefix: 'shop:prod:idem:',
      leaseMs: 30_000, // claim lease, renewed while the handler runs
    }),
  },
});
```

A retry of an `idempotent: true` action replays the stored result on any
replica and after a restart; the handler runs once
(`tests/actions-idempotency-processes.test.ts` runs two OS processes).

- `begin` claims the runtime's key (SHA-256 of tenant, subject, group,
  action, version and the client key, so users never share records) with
  `SET NX PX`. The claim is a lease owned by a random token and renewed every
  third of `leaseMs` while the handler runs.
- `complete` replaces the claim with the outcome for the runtime's TTL
  (default 24 h) and `abandon` deletes it, both only while this process still
  owns the claim (`WATCH`/`MULTI`/`EXEC`).
- Fail closed: a Redis error or a corrupt record fails the call with
  `500 INTERNAL` before the handler runs. If storing the outcome fails (Redis
  down, outcome over `maxOutcomeBytes`, default 4 MiB) the claim is kept
  rather than released, so retries get `409 IDEMPOTENCY_IN_PROGRESS` until the
  lease lapses.
- A process killed mid-handler stops renewing; after one lease a retry runs
  the handler again (the crashed attempt recorded no outcome). Make handlers
  with irreversible effects idempotent at the provider too (for example a
  payment provider's own idempotency key).
- Completed records last only as long as Redis keeps them: enable persistence
  (AOF) if a Redis restart must not forget them, and size `maxmemory` with a
  `volatile-*` policy so records are not evicted early.

### Shared cache

```ts
import { Cache, RenderCache, FragmentCache } from '@nestvexa/cache';
import { RedisCacheStore } from '@nestvexa/realtime-redis/cache';

const cache = new Cache({
  store: new RedisCacheStore({ ...redis, prefix: 'shop:prod:cache:' }),
  lock: { ttlMs: 10_000, waitMs: 3000 }, // the defaults
});
const fragments = new FragmentCache({
  engine: hbs,
  renders: new RenderCache(cache),
  assetVersion,
});
```

- Entries are stored under the SHA-256 of the cache key with `PX` set to
  their `staleUntil`; `maxEntryBytes` (default 1 MiB) bounds one entry and
  `maxEntries` (default 50000) the shared index (expired entries, then those
  closest to expiry, are evicted). Set Redis `maxmemory` as the hard bound.
- Tag invalidation is visible on every instance at once: `invalidateTags`
  bumps a per-tag counter before it deletes the tagged entries, and reads
  compare the counters recorded in the entry. A computation that overlaps an
  invalidation on any instance is not stored (`discarded`).
- Stampede protection across processes: `Cache` takes a short `SET NX PX`
  lock per key; the other instances poll for its value for up to `waitMs`,
  take the lock over if the holder fails, and compute anyway after `waitMs`.
  `lock: false` keeps single flight per process (one computation per
  instance).
- Values carrying a Live snapshot, a CSRF token or signed island props are
  refused (`CacheRefusedError`) by `Cache` and again by the store, so they
  never reach Redis.
- Reads degrade to computing when Redis is down (`store-error`);
  invalidation failures propagate.

Every replica must share the realtime `secrets`, the public `origin` and an
identity that resolves identically on every replica (a shared session store or
a signed stateless cookie). The
[distributed example](../../examples/distributed-live) runs replicas on Express
and Fastify behind one Redis.

## Public API

| Export                                                              | Purpose                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `RedisLiveStore`, `RedisLiveStoreOptions`                           | `LiveStateStore` and `LiveActionCoordination` over one Redis primary                  |
| `RedisActionIdempotencyStore`, `RedisActionIdempotencyStoreOptions` | From `@nestvexa/realtime-redis/actions`; shared `ActionIdempotencyStore`              |
| `RedisCacheStore`, `RedisCacheStoreOptions`                         | From `@nestvexa/realtime-redis/cache`; shared `CacheStore` with tags and locks        |
| `RedisRealtimeBroker`, `RedisRealtimeBrokerOptions`                 | From `@nestvexa/realtime-redis/realtime`; re-export of `RespRealtimeBroker`           |
| `RespConnection`, `RespError`, `encodeCommand`, `parseReplies`      | Low-level RESP2 client used by the store (`RespConnectionOptions`, `RespReply` types) |

## `RedisLiveStore` options

| Option                             | Default          | Meaning                                                                       |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `host`, `port`                     | `127.0.0.1:6379` | Redis primary                                                                 |
| `username`, `password`, `database` | —, —, `0`        | ACL user, AUTH password (never logged), logical database                      |
| `prefix`                           | `nestvexa:live:` | Key namespace per application/environment (`[a-z0-9:._-]{0,64}`)              |
| `namespace`                        | none             | `(binding) => ({ tenant, user? })`: per-tenant key spaces, user index         |
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
- A fence key (`f:<token hash>`) is written before the action callback runs
  and removed by the same `EXEC` that commits. If a replica crashes, Redis
  becomes unreachable after the callback, or the lease lapses, the fence stays
  and the next attempt invalidates the entry (410) instead of running the
  callback a second time: callbacks run at most once per revision.

## Tenant and user namespacing

With `namespace: (binding) => ({ tenant, user })` (the host built the binding,
so it resolves both; never from request input), every key of a tenant lives
under `<prefix>t:<tenant>:` — state `s:`, lease `l:`, fence `f:`, binding
index `b:`, user index `u:<sha256(user)>`, tenant index `i` and user list `us`
— so one tenant can be listed with `SCAN MATCH <prefix>t:<tenant>:*` or
restricted with Redis ACL key patterns. Only the tenant id appears in clear
(1–64 `[A-Za-z0-9._-]`; pass an opaque id if it is sensitive); tokens, bindings
and users are SHA-256 hashes. Each record stores its tenant and a read through
another tenant's key space is refused. `<prefix>p:<token hash>` maps a token to
its tenant for host-only `delete(token)`.

- `revokeTenant(tenant)` deletes every entry, index and lease of the tenant
  (tenant offboarding), in atomic rounds of 64 bindings that WATCH the indexes,
  so entries created meanwhile are caught by the next round.
- `revokeUser(tenant, user)` signs a user out everywhere (all sessions).
- Changing the option makes existing entries unreadable (browsers reload).

## Failure behaviour

| Failure                                   | Result                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Redis unreachable, timeout, error reply   | `503 STORE_UNAVAILABLE` (retry later); state is kept, never `410`        |
| Outage after the action callback ran      | `503`; the fence remains, so the retry is `410` (no second execution)    |
| Replica crash or lease lapse mid-action   | Other replicas: `409 COMPONENT_BUSY` until the lease expires, then `410` |
| Tampered, foreign-tenant or undecryptable | `410 INVALID_SNAPSHOT` (indistinguishable from unknown)                  |
| Per-binding capacity / in-flight limit    | `503 STORE_CAPACITY`                                                     |

The original I/O error is attached as `cause` for host logs.

Every connection (`RespConnection`, and the two connections inside each store
and queue) bounds connection attempts and commands with `commandTimeoutMs`
(default 5000) and has a circuit breaker. After 5 consecutive connection
failures, closes or timeouts, commands fail fast with `CircuitOpenError` for 1
second without touching the network. The Live store maps that error to the
same retryable `503 STORE_UNAVAILABLE`, with the `CircuitOpenError` as
`cause`. Then one probe command decides whether the circuit closes. Error
replies never count. Tune it with
`circuitBreaker: { failureThreshold, cooldownMs }` or turn it off with
`circuitBreaker: false`, and read the state from `connection.circuit`. See
[timeouts and circuit breakers](../../docs/guides/resilience.md).

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

Cost: about eight round trips per Live action (read, lease, re-read, fence,
watched commit). Clocks of all replicas must be NTP-synchronized.

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

## Security

Redis is inside the trust boundary, but records read from it are still
validated: tampered, foreign-tenant or undecryptable entries fail as `410`, job
records are re-validated before use, and keys hold SHA-256 hashes of tokens,
bindings and users, never raw values. `encryptionKeys` encrypts Live state with
AES-256-GCM, and replay records are sealed by Live with a key the store never
sees. The password is never logged. Connections are plain TCP (`node:net`,
no TLS support), so keep Redis on a private network or behind a TLS tunnel,
and use ACL users and per-tenant key patterns where needed.

## Performance

About eight round trips per Live action and about five per job claim or
update (see above). Commands time out after `commandTimeoutMs` (5 s) and a
circuit breaker fails fast during outages. Capacity is bounded per binding
(`maxEntriesPerBinding`) and per process (`maxInFlight`). Throughput with two
replicas plus Redis has not been benchmarked
([benchmarks](../../docs/testing/benchmarks.md)).

## Compatibility

- Node `^22.13.0 || ^24.0.0`, ESM only. Peers `@nestvexa/live` and, for
  `/realtime`, `@nestvexa/realtime`.
- Redis 6.2+ over RESP2; tested against Redis 7 standalone. Single primary
  only: no Sentinel discovery, no tested failover, no Redis Cluster.
- Replicas on Express and Fastify (four-replica browser suite in
  `pnpm test:services`).

## Status and limits

Status: **Shipped (alpha)**. `RedisLiveStore` passes the shared store contract suite and, with the realtime broker, a real Redis 7 run including the four-replica (Express and Fastify) browser acceptance suite ([services evidence](../../docs/implementation/services-evidence-2026-11-05.json)).

- Single Redis primary only; no Sentinel discovery or tested failover, and Redis Cluster is not supported (DATA-004).
- Cross-replica idempotent replay and identity locks are covered by the real-Redis service run (`redis-live-coordination`, PROT-017).
- The broker implementation lives in `@nestvexa/realtime`; this package re-exports it (REAL-002, recorded in ADR 0032).
- Realtime delivery is at-most-once and replay windows are per replica; presence is shared through `RedisPresenceStore`. Distributed load testing is not done (REAL-014).
- About eight round trips per Live action; replica clocks must be NTP-synchronized.
- Tenant/user namespacing, revocation and the fence after a SIGKILLed replica are checked against real Redis (`redis-live-namespace` in `pnpm test:services`).
- All replicas sharing a prefix must use the same `ttlMs`: index lifetimes follow the newest entry.
- `RedisActionIdempotencyStore` and `RedisCacheStore` are tested on the RESP double (`tests/actions-idempotency-store.test.ts`, `tests/actions-idempotency-processes.test.ts`, `tests/cache-redis-store.test.ts`) and against real Redis (`redis-action-idempotency` and `redis-cache-store` in `pnpm test:services`). A claim survives a Redis outage only as long as its lease; tag index sets of tags that are never invalidated keep members of expired entries until the set itself expires (48 h after its last write).

## Testing

```sh
pnpm --filter @nestvexa/realtime-redis test
pnpm exec vitest run tests/live-store-contract.test.ts tests/realtime-job-queue.test.ts \
  tests/realtime-distributed.test.ts                       # RESP test double
pnpm exec vitest run tests/live-shared-action-policy.test.ts
pnpm exec vitest run tests/actions-idempotency-store.test.ts
pnpm exec vitest run tests/actions-idempotency-processes.test.ts  # two OS processes
pnpm exec vitest run tests/cache-redis-store.test.ts
NESTVEXA_REDIS_PORT=6379 pnpm test:services                # real Redis
```

Runs `tests/live-store-contract.test.ts` and `tests/live-shared-action-policy.test.ts` with the root Vitest config against an in-process RESP test double; the tests import `packages/*/dist`, so run `pnpm --filter @nestvexa/realtime-redis... build` first. `NESTVEXA_REDIS_PORT=6379 pnpm test:services` runs the store and broker against real Redis plus the two-replica browser suite, separately from the package script.

See [ADR 0032](../../docs/adr/0032-distributed-state-and-redis.md) and the
[production services guide](../../docs/guides/production-services.md). License: MIT.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
