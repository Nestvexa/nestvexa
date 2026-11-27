# Stores round 8 (branch `r8-stores8`)

Scope: final ledger audit gaps (`final-audit-c.json`) in REL-019, REL-021 and
REVIEW-016 (server-action idempotency is process-local), REL-013 and
REVIEW-017 (no shared cache store), and REVIEW-008 (no Live guard against
secret-like `@State` names). Worktree `nv-wt/stores8`, from main `748681d`;
ports 4280-4299. **Real Redis was not run:** the Docker daemon was not
running after a host reboot and the machine had about 0.5 GB of free RAM, so
no `nv-r8-redis` container was started. The two new `scripts/services-check.mjs`
sections were executed once against the RESP double through an uncommitted
harness (both passed, all steps; the `KEYS` assertion was skipped because the
double does not implement `KEYS`). The coordinator should run
`NESTVEXA_REDIS_PORT=6400 pnpm test:services` against a real Redis 7.

## REVIEW-016 / REL-019 / REL-021: shared server-action idempotency

**Implemented.** `ActionIdempotencyStore` was already a pluggable interface in
`@nestvexa/actions` (memory default, `idempotency.store` option). This round
adds the shared implementation where the Redis adapters live:

- `RedisActionIdempotencyStore` in
  `packages/realtime-redis/src/action-idempotency.ts`, exported from the new
  entry point `@nestvexa/realtime-redis/actions` (imports only types from
  `@nestvexa/actions`, never loads `@nestvexa/live`; `scripts/boundaries.mjs`
  unchanged and passing: actions and Live still import no Redis code).
- Atomic claim: `SET <prefix><key> {f, o} NX PX lease`. The key is the
  runtime's SHA-256 of tenant, subject, group, action, version and client key
  (owner/tenant scoped); the store rejects anything that is not a 64-char hex
  digest. Records hold only the input fingerprint, the claim owner token or
  the outcome, never identities.
- Lease: default 30 s (1 s to 10 min), renewed every third of the lease by
  the owning process (owner-checked `WATCH`/`MULTI`/`EXEC` + `PEXPIRE`). A
  crashed process stops renewing; its claim lapses after one lease.
- Result storage: `complete` replaces the claim with the outcome for the
  runtime TTL (`idempotency.ttlMs`, default 24 h) only while this process
  still owns the claim; `abandon` deletes it the same way, so a lapsed claim
  taken over by another replica is never overwritten or dropped.
- Fail closed: Redis errors (connection, timeout, error reply, circuit open)
  and corrupt records reject `begin`, so the runtime answers `500 INTERNAL`
  and the handler never runs. If storing the outcome fails (Redis down,
  lapsed claim, outcome over `maxOutcomeBytes`, default 4 MiB) the claim is
  kept (the runtime's follow-up `abandon` is ignored), so retries get
  `409 IDEMPOTENCY_IN_PROGRESS` until the lease lapses instead of re-running
  the effect at once. Error messages never contain keys or values.
- Tests:
  - `tests/actions-idempotency-store.test.ts` (20 tests): one contract suite run
    against `MemoryIdempotencyStore` and `RedisActionIdempotencyStore` on the
    RESP double in `tests/support/resp-double.ts` (claim/in-progress/replay,
    mismatch pending and done, abandon, unclaimed completion, TTL expiry,
    two instances), and Redis-specific cases: lease renewal over 2.5 lease
    periods and lapse after a simulated crash, no commit over a claim taken
    over by another replica, fail-closed poisoned completion, Redis down and
    corrupt records, at-rest record shape, option/key validation. Also an
    in-process `ActionsModule` over HTTP: replay per identity (Bob's identical
    key runs separately), mismatch 409, and Redis down gives 500 with the
    handler never run.
  - `tests/actions-idempotency-processes.test.ts`: two separate OS processes,
    each a Nest app with its own `RedisActionIdempotencyStore` over one RESP
    server; the handler counts side effects in Redis. Run on A and retry on B
    replays A's result (handler ran once); after restarting A the new process
    still replays; a duplicate on B while A runs gets 409 and then replays; a
    different input is a mismatch; a process killed mid-handler blocks retries
    until its lease lapses, then the retry runs.
  - `scripts/services-check.mjs` section `redis-action-idempotency` (real
    Redis; not yet run against a real server, see above): cross-instance claim/replay/mismatch, a second OS process whose
    stored outcome replays here and whose renewed claim holds and then lapses
    after SIGKILL, PX expiry of completed records, fail-closed on an
    unreachable server.
- Docs: `packages/realtime-redis/README.md` (Server-action idempotency),
  `docs/guides/server-actions.md`, `packages/actions/README.md`,
  `docs/deployment/multi-replica-redis.md`.
- Remaining gaps: a process killed after its handler ran but before the
  outcome was stored lets a retry run again after one lease (documented:
  handlers with irreversible effects should also use a provider idempotency
  key). Records survive a Redis restart only with Redis persistence. Single
  primary only (no Sentinel discovery, no Cluster). Upload tokens are still
  process-local (out of scope; REVIEW-016 also mentions them).

## REL-013 / REVIEW-017: shared Redis cache store

**Implemented.** `RedisCacheStore` in
`packages/realtime-redis/src/cache-store.ts`, entry point
`@nestvexa/realtime-redis/cache`:

- Asynchronous `CacheStore`; entries under `<prefix>e:<sha256(key)>` with
  `PX` = `staleUntil`, so Redis enforces the TTL and raw keys (which contain
  hashed bindings anyway) never reach Redis.
- Tag index: a set per tag plus a per-tag invalidation counter.
  `invalidateTags` bumps the counter first (every instance stops serving the
  tagged entries at once, since reads compare the counters recorded in the
  entry), then deletes the indexed entries.
- `@nestvexa/cache` gained two optional `CacheStore` methods (backwards
  compatible; memory store unchanged): `tagMarker(tags)` and
  `set(key, entry, marker)` returning `false` when a tag was invalidated on
  any instance since the computation started (counted as `discarded`), and
  `lock(key, ttlMs)`.
- Stampede protection is **cross-process**: `Cache` takes a short
  `SET NX PX` lock per key (`new Cache({ lock: { ttlMs, waitMs } })`, default
  10 s / 3 s); other instances poll for the holder's value, take the lock
  over if the holder fails, and compute anyway after `waitMs`. `lock: false`
  keeps it per process (tested and documented).
- Size bounds: `maxEntryBytes` (default 1 MiB) per entry, `maxEntries`
  (default 50000) in a sorted index scored by `staleUntil` (expired entries,
  then those closest to expiry, are evicted).
- Refusal: values with a Live snapshot token, a CSRF token/field or signed
  island props are refused by `Cache` and again by the store (also inside the
  JSON text `Cache` writes), so they never reach Redis.
- Tests: `tests/cache-redis-store.test.ts` (RESP double): round trip, hashed
  keys, PX expiry; invalidation on one `Cache` visible on another; counter
  bump hides entries even if deletion failed; overlap with another
  instance's invalidation is discarded; lock computes once across two
  instances (second is `coalesced`); takeover after a failing holder and
  compute after `waitMs`; `lock: false` is per process; refusal of snapshot,
  CSRF and island values; size bounds and eviction; corrupt entries; Redis
  down (reads compute, invalidation throws); `clear` per prefix; validation.
  Existing `tests/cache.test.ts`, `tests/cache-render.test.ts`,
  `tests/cache-fragments.test.ts`, `tests/cache-poisoning.test.ts` still pass.
  `scripts/services-check.mjs` section `redis-cache-store` (real Redis; not
  yet run against a real server, see above).
- Docs: `packages/realtime-redis/README.md` (Shared cache),
  `packages/cache/README.md`, `docs/guides/caching.md`,
  `docs/deployment/multi-replica-redis.md`.
- Remaining gaps: single Redis primary only (no Sentinel discovery, no
  Cluster; REVIEW-017's Sentinel/Cluster note stays open). Tag index sets of
  tags that are never invalidated keep members of expired entries until the
  set expires 48 h after its last write. Live component refresh on other
  replicas still needs `onInvalidate` → realtime (REAL-010 end-to-end test
  still missing). REL-013 also depends on DATA/EXT rows outside this scope.

## REVIEW-008: Live secret-like `@State` guard

**Implemented.** `State()` in `packages/live/src/metadata.ts` refuses field
names matching the islands `SENSITIVE_KEY` pattern (`password`, `passwd`,
`pass`, `secret`, `token`, `apiKey`/`api_key`, `credential`, `session`,
`cookie`, `authorization`, `csrf`, `privateKey`) when the decorator is
applied, i.e. at class definition during startup, with an error naming the
class and field and the opt-out. Per-field opt-out with a reason:
`@State({ allowSensitiveName: '<3-500 character reason>' })`.

- Tests: `tests/live-sensitive-state.test.ts` (35 tests): each secret-like
  name refused, decorator syntax fails at class declaration, ordinary names
  (including `passenger`, `compass`, `author`) accepted, opt-out per field
  (a second field still fails), invalid reasons rejected, and parity with the
  islands `SENSITIVE_KEY` pattern.
- Existing users updated with explicit reasons:
  `examples/upload-to-s3/src/documents.ts` (`csrf`),
  `tests/devtools-inspector.test.ts` and `tests/devtools-browser.test.ts`
  (fixtures that check devtools redaction).
- Docs: `packages/live/README.md`; changeset notes the behaviour change.

## Merge notes

- `package.json`: new test files added to `test:unit`
  (`live-sensitive-state`), `test:integration` (`actions-idempotency-store`,
  `actions-idempotency-processes`, `cache-redis-store`) and `test:security`
  (`live-sensitive-state`, `actions-idempotency-store`, `cache-redis-store`).
- `packages/realtime-redis/package.json`: new exports `./actions` and
  `./cache`; optional peers `@nestvexa/actions` and `@nestvexa/cache` (also
  devDependencies); `@nestvexa/live` peer is now optional; lockfile updated
  (workspace links only, no new external dependency).
- `api-reports/` regenerated for `@nestvexa/cache`, `@nestvexa/live` and
  `@nestvexa/realtime-redis`.
- No Playwright entries added.

## Commands run (one test file at a time)

| Command                                                                                | Result                                                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm --filter @nestvexa/{live,cache,actions,realtime,realtime-redis} build`           | pass                                                                                                |
| `vitest run tests/live-sensitive-state.test.ts`                                        | 35/35 pass                                                                                          |
| `vitest run tests/actions-idempotency-store.test.ts`                                   | 20/20 pass                                                                                          |
| `vitest run tests/actions-idempotency-processes.test.ts`                               | 1/1 pass (204 s on the loaded host)                                                                 |
| `vitest run tests/cache-redis-store.test.ts`                                           | 14/14 pass                                                                                          |
| `vitest run tests/cache.test.ts`, `cache-render`, `cache-fragments`                    | 4/4, 12/12, 11/11 pass                                                                              |
| `vitest run tests/cache-poisoning.test.ts`                                             | 15/16 in the full file (a Vite static-middleware case timed out under load); that case passes alone |
| `vitest run tests/devtools-inspector.test.ts --testTimeout=180000`                     | 7/7 pass (the default 15 s timeout expired once under load while the app booted)                    |
| `vitest run tests/devtools-browser.test.ts --testTimeout=180000`                       | 3/3 pass                                                                                            |
| `tsc -p tsconfig.tests.json --noEmit`                                                  | only TS2307 for unbuilt example `dist` (multi-tenant, orm-*); no errors in changed files            |
| `tsc -p examples/upload-to-s3/tsconfig.json --noEmit`                                  | pass                                                                                                |
| `eslint` on changed packages, tests, example and script; `node scripts/boundaries.mjs` | pass                                                                                                |
| `pnpm api:update`                                                                      | 3 reports updated (cache, live, realtime-redis)                                                     |
| `pnpm test:services` (real Redis)                                                      | **not run** (no Docker daemon)                                                                      |
