# Agent report: data layer, state stores and caching, round 5 (DATA-004 to DATA-008)

Branch `r5-data-stores-cache`, from `main` at `1e3049a`. Spec section 15.1.
Real-service evidence: `redis:7-alpine` in Docker container `nv-r5-redis` on
host port 6397 (removed afterwards), Windows 11, Node 24.13.0. Servers on ports
4010–4011 only.

New files: `packages/cache/src/{keys,store,cache,render}.ts`,
`packages/live/src/testing.ts` (`@nestvexa/live/testing`),
`examples/data-cache/` (new workspace example), `docs/guides/caching.md`,
`tests/cache-render.test.ts`, `tests/cache-example.test.ts`, three changesets.
Changed: `packages/realtime-redis/src/live-store.ts`,
`packages/live/src/errors.ts` (new code `STORE_UNAVAILABLE`),
`packages/live/package.json` (`./testing` export), `packages/cache/src/index.ts`,
`tests/live-store-contract.test.ts`, `tests/support/resp-double.ts`
(`SRANDMEMBER`), `scripts/services-check.mjs` (section `redis-live-namespace`),
root `package.json` test groups, READMEs of cache, live and realtime-redis,
`docs/guides/{realtime,live-protocol}.md`, `docs/reference/live-protocol.md`.

## DATA-004 — Redis-backed state

What `RedisLiveStore` already had (verified, unchanged): hashed token/binding
keys under a prefix, `PX` TTL plus stored `expiresAt`, versioned JSON records
validated on every read, optional AES-256-GCM with the key name as AAD and
rotation, `SET NX PX` lease and `WATCH`/`MULTI`/`EXEC` compare-and-set on lease
owner and revision.

Gaps closed:

- **Tenant/user namespaced keys**: option `namespace: (binding) => ({ tenant, user? })`
  (host-resolved, never from request input). Every key of a tenant lives under
  `<prefix>t:<tenant>:` (state `s:`, lease `l:`, fence `f:`, binding index `b:`,
  user index `u:<sha256(user)>`, tenant index `i`, user list `us`), so a tenant
  is listable with `SCAN MATCH` and restrictable with ACL key patterns. Records
  store their tenant; a record read through another tenant's key space, or with
  a rewritten tenant, is refused. `<prefix>p:<token hash>` maps a token to its
  tenant so host-only `delete(token)` still works. New `revokeTenant(tenant)`
  (tenant offboarding, atomic rounds of 64 bindings watching the indexes) and
  `revokeUser(tenant, user)` (sign out everywhere).
- **Version enforcement / at most once**: a fence key written before the action
  callback and removed by the same `EXEC` that commits. A crash, an outage after
  the callback or a lapsed lease leaves the fence; the next attempt invalidates
  the entry (410) instead of running the callback again. Previously a lapsed
  lease let a second replica run the callback concurrently, and an outage
  during commit allowed a retry to re-execute it.
- **Documented failure behaviour**: Redis I/O failures (connection, timeout,
  error reply) now surface as `LiveProtocolError('STORE_UNAVAILABLE', 503)`
  (`retry-later`, cause kept for logs) instead of generic 500 errors, never as 410. Failure table in `packages/realtime-redis/README.md#failure-behaviour`;
  guide `docs/guides/caching.md`.

Tests: `tests/live-store-contract.test.ts` — the full contract suite on a
namespaced `RedisLiveStore` (RESP double); "RedisLiveStore tenant/user
namespacing" (key layout and hashing, nothing outside tenant spaces, moved and
rewritten records refused, `revokeUser` across sessions, `revokeTenant` of 71
bindings in rounds leaving no tenant key, other tenant kept, pointer delete,
namespace validation); "RedisLiveStore failure behaviour" (planted fence →
410 without running the callback; lapsed lease → second replica gets 410 and
the callback ran once; server closed during the callback → 503, peek 503, and
after Redis returns with its data the retry is 410 with one execution);
outage test now asserts `STORE_UNAVAILABLE` with `cause`.

Real Redis (`scripts/services-check.mjs`, section `redis-live-namespace`):
tenant key spaces via `SCAN MATCH`, no raw values in keys, `revokeUser`,
`revokeTenant` of 100 bindings with no tenant key left, and a **SIGKILLed
child process mid-action**: the parent sees `COMPONENT_BUSY` while the lease
lives, then `INVALID_SNAPSHOT`, and its callback never runs. **This check
found two bugs, fixed in `e68df55`**: `revokeTenant` counted bindings already
revoked by `revokeUser`, and left per-user index keys behind (100 keys). The
RESP-double test was tightened to the exact count and an empty tenant space.

Remaining gaps: single Redis primary only (no Cluster, no tested failover);
replicas sharing a prefix must use the same `ttlMs` (index lifetimes follow
the newest entry); tenant ids appear in clear in key names (documented: pass an
opaque id if sensitive); one extra round trip per action (about eight).

## DATA-005 — pluggable custom store with lock/concurrency semantics

The `LiveStateStore` interface already existed and the runtime already accepts
any structurally valid store (the ledger's outstanding issue about
`MemoryLiveStore` being required is stale). Added:

- `liveStoreContract(factory)` in `@nestvexa/live/testing`: a reusable,
  framework-independent conformance suite (`node:assert`, no vitest
  dependency) that a third-party store registers with any runner. Cases:
  structural interface; binding isolation with indistinguishable 410s (foreign
  binding, foreign tenant, unknown, malformed, empty); detached frozen
  snapshots and unique tokens/ids; JSON validation; revision + 1 and stale /
  replayed revisions refused before the callback; `COMPONENT_BUSY`; **8
  racing transactions → exactly one callback**; invalidation after a failed
  callback or oversized HTML; no resurrection after revoke/delete/expiry; TTL;
  revoke/delete; children; per-binding capacity; replica sharing.
- Lock, version and failure semantics documented in
  `docs/guides/caching.md#custom-live-state-stores` and the Live README.
- Example custom store `examples/data-cache/src/sqlite-live-store.ts`
  (`node:sqlite`, no dependency): lease via one conditional `UPDATE`, commit as
  compare-and-set on revision, lease owner and lease expiry, abandoned leases
  invalidate; several instances on one file share state.

Tests: `tests/live-store-contract.test.ts` runs the suite against
`MemoryLiveStore`, `RedisLiveStore`, namespaced `RedisLiveStore` and
`SqliteLiveStore` (two instances on one file as replicas), plus two negative
tests proving the suite fails a store that ignores revisions and one whose
`peek` ignores the binding. 68/68 passed. `tests/cache-example.test.ts` runs
Live actions through the Nest runtime against the SQLite store.

Remaining: the SQLite store is an example (plain JSON at rest, experimental
`node:sqlite` warning), not a supported production store.

## DATA-006 — render/data caching only when safe

`RenderCache` in `@nestvexa/cache`: `render(request, render)` returns
`{ html, status }`. The key always contains component, revision, renderer,
locale (case-insensitive), tenant, permission scope (order-insensitive) and
asset version — all **required** fields validated at runtime (`tenant: null`
and `permissions: []` must be explicit), plus optional extra `vary`. Audiences
`public`, `tenant` (new `tenant` cache scope: shared only within a tenant) and
`private`. **Private per-user HTML is never stored by default** (status
`bypass`); `cachePrivate: true` stores it keyed by binding + tenant, without
SWR. Vary values must be finite (NaN previously collided with null).

Tests: `tests/cache-render.test.ts` — fast-check property (400 runs): keys are
equal exactly when every context field is equal; validation of every field;
private default never stores (store size 0, `bypass` events); with
`cachePrivate`, alice/bob/other-tenant never share a computation or value even
when concurrent; tenant HTML separated by tenant, permission scope, locale and
asset version. `tests/cache-example.test.ts` — the same over HTTP in the
example (second Alice session `hit`, Bob with fewer permissions `miss` and no
edit links, Carol never sees tenant-a products, Arabic separate key, account
fragment always `bypass`).

Remaining: caching is explicit per fragment; the HBS/Live/Inertia pipelines do
not cache automatically (by design, Live HTML is never cacheable).

## DATA-007 — tags, SWR, telemetry, stampede protection

- Tags and invalidation (existing) plus: a computation that overlaps an
  invalidation of one of its tags returns its value but is not stored
  (`discarded`), closing the read-before-write race.
- SWR only for `public` and `tenant` scopes; one background refresh; a failing
  refresh keeps serving stale until `staleUntil` (`refresh-error` event).
- Telemetry: `onEvent` (hit, miss with duration, stale, coalesced, bypass,
  refused, discarded, compute-error, refresh-error, store-error, invalidate)
  without keys, bindings, tenants or values; `instrumentation` spans
  `nestvexa.cache.compute` compatible with `LiveInstrumentation` from
  `@nestvexa/observability`; hook exceptions ignored; `metrics` extended.
- Stampede protection: per-key single flight (50 concurrent misses → one
  computation); `lookup()` reports `coalesced`.
- `CacheStore` methods may be asynchronous; store failures degrade (get →
  compute, set → not stored, `store-error`), invalidation failures propagate.
- `new Cache({ store, now, onInvalidate, onEvent, instrumentation })`; the
  positional constructor still works.

Tests: `tests/cache-render.test.ts` (tags across permission scopes and the
discard race, SWR with failing refresh, stampede, telemetry/spans with a
throwing hook, failing async store, constructor forms);
`tests/cache-example.test.ts` (admin write invalidates every tenant-a
fragment and not tenant-b; `/api/cache` metrics, admins only). Existing
`tests/cache.test.ts` (4/4) and `tests/cache-poisoning.test.ts` (16/16) pass.

Remaining: no shared (Redis) `CacheStore` ships; stampede protection and the
discard check are per process (cross-replica invalidation via `onInvalidate`
and realtime is documented, not automated).

## DATA-008 — no API that shares private signed snapshots

`cacheableJson` / `CacheRefusedError`: values containing `data-nv-snapshot`,
`data-nv-csrf`, `data-nv-props-token`, a `_csrf`/`csrf-token` field, or any
object shaped like a Live `StateSnapshot` (43-character token next to a
numeric revision) are refused in every scope, for the caller **and every
coalesced waiter**, and never stored. Tests: `tests/cache-render.test.ts`
(5 markers × 3 audiences, waiter also rejected, store empty, snapshot-shaped
data refused); `tests/cache-example.test.ts` (a real page with a mounted Live
component is refused; a Live snapshot from Alice's page is rejected with 410
for Bob).

## Example

`examples/data-cache` (`@nestvexa/example-data-cache`, default `PORT` 4000):
tenant catalog fragment, public footer, personal account fragment (bypass),
admin-only CSRF-protected write with tag invalidation, Arabic RTL locale,
Live cart on the SQLite custom store, metrics endpoint. README included.

## Verification (this session)

- `pnpm lint` (eslint + `scripts/boundaries.mjs`): passed; core does not
  depend on Redis.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: no errors in the files of
  this branch (the worktree was rebuilt partially, so unrelated test files
  importing unbuilt packages report missing `dist`).
- `pnpm exec prettier --write` on every changed file.
- Vitest, one file at a time: `tests/live-store-contract.test.ts` 68/68,
  `tests/cache-render.test.ts` 12/12, `tests/cache-example.test.ts` 1/1,
  `tests/cache.test.ts` 4/4, `tests/cache-poisoning.test.ts` 16/16,
  `tests/live-protocol-contract.test.ts` 22/22 (error catalog incl.
  `STORE_UNAVAILABLE`), `tests/live-shared-action-policy.test.ts` 7/7.
- `NESTVEXA_REDIS_PORT=6397 NESTVEXA_SERVICES_BROWSER=0 node scripts/services-check.mjs`:
  `redis`, `redis-live-store`, `redis-live-namespace`, `redis-live-coordination`,
  `redis-job-queue`, `redis-presence` all passed (browser section not run).
- Not run: browser tests (no browser-facing change beyond the example, which is
  covered over HTTP), `pnpm docs:build`, `pnpm size:check` (no client change).

Note: the pre-existing two-application test in `live-store-contract.test.ts`
takes 17–19 s on this host (cold Nest start) and now has a 60 s timeout.
