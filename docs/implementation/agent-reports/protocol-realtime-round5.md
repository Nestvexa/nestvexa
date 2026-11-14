# Agent report: Live protocol and realtime, round 5 (PROT-017, PROT-013, REAL-010, REAL-014, REAL-002)

Branch `r5-protocol5`, from `main` at `928b2f1`. Windows 11, Node 24.13.0,
servers on ports 4080–4083 only. The OS temp cleaner deleted the worktree once
mid-task (all uncommitted work lost and redone); the branch is committed after
every step since. Docker Desktop was not running and the host had about 500 MB
of free RAM, so no Redis container was started (none to remove) and
`pnpm test:services` was **not** run (see REAL-014).

## PROT-017 — read-only refresh; signed snapshots

**Read-only refresh (implemented).** `$sync` with `x-nestvexa-resync: 1` and no
updates (`packages/live/src/runtime.ts`, `refresh()`):

- passes the full admission (origin, content type, identity, CSRF, asset
  version, rate limit, envelope, reference ownership, component route, `$sync`
  authorization) but reads with `store.peek` only, never `transaction`: the
  snapshot, revision, state and expiry are unchanged;
- runs `boot`/`hydrate`/`dehydrate` and renders (computed values re-read data),
  discards effects queued by hooks, persists no host session state, and never
  invalidates the reference on failure;
- fails with `409 REFRESH_CONFLICT` (`x-nestvexa-recovery: commit`) before
  anything is created or stored when the rendered public state differs from the
  stored state or a child would be mounted, removed or re-propped
  (`RenderContext.readOnly`);
- `x-nestvexa-resync: commit` is the explicit committing fallback (the previous
  resync behaviour). Any other value, updates, input or an action route is
  `400`/`UNEXPECTED_INPUT`.

Client (`packages/client/src/index.ts`, `transport.ts`): realtime invalidations
of components without a listener and the `STALE_REVISION` recovery now send the
read-only refresh (no drafts; the same revision is accepted); a
`REFRESH_CONFLICT` hint triggers one committing resync; a commit refused the
same way suspends (no loop); the hint is ignored outside a refresh.
`LiveRenderInspection.cause` gains `refresh` (observability inspector/devtools).

Bug found by this round's own browser run and fixed before commit: the first
version returned state changed by hooks without storing it; the starter-live
"Retry report" action then read a stale stored job status
(`tests/browser/realtime.spec.ts` "a failing report … can be retried" failed).
The refresh now refuses such renders (`REFRESH_CONFLICT`), so a successful
refresh always returns exactly the stored state.

Tests: `tests/live-refresh.test.ts` (new, Express and Fastify, 22): no
transaction, same revision/state/expiry, repeatable, next action on the same
revision, stale-client recovery, computed re-read, effects discarded,
state-changing hook refused then committed, unchanged children stubbed, new /
removed / re-propped child refused then committed, invalid header values,
updates, action routes, input, CSRF, component mismatch, unknown reference,
catalog. `tests/live-stale-revision.test.ts` updated (resync keeps the
committed revision). `tests/client-transport-lifecycle.test.ts` +4 (same
revision applied, commit once on conflict, no loop, hint ignored outside a
refresh). `tests/browser/realtime.spec.ts` now asserts the cross-session refresh
is marked `x-nestvexa-resync: 1`, sends no updates and keeps the revision.

**Signed snapshots: ADR instead of implementation.**
[ADR 0037](../../adr/0037-server-state-references-and-read-only-refresh.md)
records why server-side state makes HMAC-signed browser snapshots unnecessary
(the browser holds a 256-bit reference; integrity, binding, replay, expiry and
revocation are enforced by the store) and where key rotation does apply:
realtime token secrets and `RedisLiveStore` `encryptionKeys`. New test in
`tests/live-store-contract.test.ts`: "rotates encryption keys without
invalidating open pages and rejects retired keys" (grace window with
`[current, previous]`, commits re-encrypt under the current key, a store with
only the retired key and a store after retirement both fail closed with `410`).

Docs: `docs/reference/live-protocol.md` (Read-only refresh, error table),
`docs/guides/offline.md`, `packages/client/README.md`, `packages/live/README.md`,
ADR 0037 (renumbered from 0036 at merge) and its index entry. Changeset `live-read-only-refresh`.

Remaining: the refresh is authorized as `$sync` (a separate `$refresh` policy
action would break every existing host allowlist); components that copy
external data into `@State` in a hook pay refresh + commit when it changes.

## PROT-013 — asset-version reload and logout in a browser

`examples/browser-lab` now sets `assetVersion` (`ASSET_VERSION`, default
`lab-build-1`) and has `POST /logout` (origin-checked; `store.revoke(binding)`,
then session destroy). New `tests/browser/session-recovery.spec.ts`:

1. A page rendered by the previous build (first response rewritten to
   `lab-build-0`, as a cached pre-deploy copy) clicks Increment: `409
ASSET_VERSION_MISMATCH` with `x-nestvexa-reload: asset-version`, the client
   reloads the document, the refused action never ran (count 0), the current
   build then works (count 1).
2. A `nestvexa:reload` listener that calls `preventDefault()` keeps the
   document; nothing applies.
3. Sign out from another tab while the page is open: the next action is `401`
   before component code runs; the body carries no state, reference or
   identity; the client reports `HTTP`, keeps the last authorized DOM and does
   not reload; after signing in again (reload, new session) the page works with
   fresh state; the old reference replayed with the new session's CSRF is
   `410 INVALID_SNAPSHOT`.

Results: Chromium 3/3; Firefox and WebKit see Verification. Root
`playwright.config.ts` already serves browser-lab on 3860; no new entry needed.

## REAL-010 — `@DependsOn` and tag invalidation

`packages/live/src/metadata.ts`: `@DependsOn(...tags | (component) => tags)`
(class decorator, 1–32 entries, tags validated at decoration with the cache tag
grammar, one per class) and `liveTagChannel(tag)` → `tag:<tag>` (the channel
`tagChannel` from `@nestvexa/cache` names). The runtime adds the tag channels
to the signed subscription token next to `@RealtimeChannels` (deduplicated, at
most 32). `packages/live/src/dependencies.ts`: `LiveTags` (exported by
`LiveModule`) with `invalidate(tags)` (validates the whole batch, then one
empty event per distinct tag through the host's `events`/`realtime`
publisher) and `listener`, a bound `(tags) => Promise<void>` matching `Cache`'s
existing `onInvalidate` callback. Live does not import `@nestvexa/cache` (the
structural callback is the whole interface, so the cache-tags branch can merge
independently). No dependency detection.

Test `tests/live-dependencies.test.ts` (new, Express and Fastify, real
`RealtimeModule` and SSE, 10): metadata and decoration-time rejections; signed
channels per component (static tag, tag function, mixed with
`@RealtimeChannels`, none for undeclared); **end to end**: a `Cache` wired to
`LiveTags.listener`, a cached total hidden after a write, `cache.invalidate`
drops the entry and publishes `tag:orders:tenant-a`, only the dependent SSE
subscription receives it, the dependent component's read-only refresh shows the
recomputed value at the same revision, the unrelated subscription receives
nothing; duplicate tags published once, an invalid batch publishes nothing; no
publisher fails clearly. Docs: `docs/guides/realtime.md` (Caching with declared
dependencies), `docs/reference/live-protocol.md` (Data dependencies),
`packages/cache/README.md`, `packages/live/README.md`. Changeset
`live-depends-on`.

Remaining: no browser test of `@DependsOn` specifically (the browser path is the
same invalidation → refresh the realtime specs cover); no example app uses it.

## REAL-014 — slow client in the multi-replica suite

- Hub: `tests/realtime.test.ts` "bounds a stalled consumer and closes it
  without delaying other subscribers" (a delivery stuck on the policy; the
  other subscriber receives all 20 events in order; the stuck one is closed
  `slow-consumer` at the queue bound; a late policy answer delivers nothing).
- Two replicas over the RESP double: `tests/realtime-distributed.test.ts`
  "slow consumers across replicas" (receiver on Express and on Fastify): 300 ×
  15 KB events published on the other replica; the healthy SSE subscriber gets
  all 300 in order; the stalled one is disconnected (`hub.size` 2 → 1), its
  drained stream ends with `event: close` / `slow-consumer`, it received less
  than half the bytes and fewer than all events; the healthy stream keeps
  working; no connection left.
- Real Redis, four replicas: `tests/services/distributed.spec.ts` "a stalled
  subscriber is disconnected by its replica without slowing other browsers"
  (Express a publishes through Redis via the new acceptance-only
  `POST /api/load/broadcast`, enabled by `ACCEPTANCE_LOAD_TOOLS=1` in
  `playwright.services.config.ts`; a stalled raw SSE client on Fastify c is
  dropped, a browser on c receives every event and Live still works, zero
  connections afterwards). **Written but not run** (no Docker/Redis on this
  host). A standalone smoke of the route (one Express replica, memory broker,
  port 4083): healthy subscriber 300/300, stalled one closed `slow-consumer`
  after 590 KB of 4.5 MB.

**Finding (not fixed):** the 256 KiB transport bound is checked synchronously
in `send`, so more than 256 KiB published on one replica within one event-loop
turn disconnects every local subscriber, healthy ones included (seen in the
smoke before the route yielded between publishes: the healthy client got 21
events). Events from Redis arrive over several socket reads and do not trigger
it. Recorded in ADR 0032 (round 5 amendment); a drain-aware bound is the
follow-up.

## REAL-002 — Nest gateway and broker location

ADR 0032 amendment (round 5): no `@nestjs/websockets` gateway, with the
rationale (one authorization path for every transport, no two extra peers, no
second wire format in the client budget) and a table of the exact
compatibility (Express/Fastify `upgrade` listener, path-scoped, lifecycle,
guards not applied, message format and close codes). Not tested: coexistence
with a host `@WebSocketGateway` on the **same** HTTP server through a platform
adapter, which may reject upgrades for paths it does not own; documented with
the workaround (own port, or SSE/polling). Broker move declined in the same
amendment: a backward-compatible re-export from `@nestvexa/realtime` would make
it depend on `@nestvexa/realtime-redis` (cycle, mandatory Redis code and Live
peer), which the boundaries rules forbid. Changeset `realtime-round5-evidence`.

## Verification

All on this host, one test file and one browser at a time.

- `pnpm install --frozen-lockfile`, `pnpm build`: passed. Rebuilt afterwards:
  `@nestvexa/live`, `@nestvexa/client`, `@nestvexa/observability`,
  `example-browser-lab`, `example-distributed-live`.
- `pnpm lint` (eslint + boundaries): passed.
  `pnpm exec tsc -p tsconfig.tests.json --noEmit`: 0 errors. Prettier on every
  changed file: clean.
- `pnpm size:check`: 47,745 / 49,152 gzip bytes (main 47,715; +30).
- vitest: `tests/live-refresh.test.ts` 22/22; `tests/live-stale-revision.test.ts`
  10/10; `tests/live-dependencies.test.ts` 10/10;
  `tests/live-store-contract.test.ts` 32/32;
  `tests/client-transport-lifecycle.test.ts` 68/68;
  `tests/client-realtime.test.ts` 14/14; `tests/live-protocol-contract.test.ts`
  22/22; `tests/devtools-inspector.test.ts` 7/7; `tests/realtime.test.ts` 14/14;
  `tests/realtime-distributed.test.ts` slow-consumer scenario 2/2 (the rest of
  that file is unchanged and was not rerun).
- Playwright (uncommitted `playwright.local.config.ts`, ports 4080–4082):
  `session-recovery.spec.ts` Chromium 3/3, Firefox 3/3, WebKit 3/3;
  `runtime-resilience.spec.ts` Chromium 9/9 (browser-lab with the new asset
  version); `realtime.spec.ts` (starter-live) Chromium 7/7 after the refresh fix
  (6/7 before, the regression described under PROT-017);
  `realtime-dashboard.spec.ts` Chromium 6/6. Firefox and WebKit were not run for
  the last three.
- **Not run:** `pnpm test:services` / `scripts/services-check.mjs` (no Docker
  daemon, about 500 MB free RAM, and the suite starts seven servers). The new
  four-replica slow-subscriber test and the read-only refresh on
  `RedisLiveStore` have no real-Redis evidence yet. Coordinator: run
  `NESTVEXA_REDIS_PORT=<port> pnpm test:services` on an idle host.

## Merge notes

- `package.json`: `tests/live-refresh.test.ts` and `tests/live-dependencies.test.ts`
  join `test:integration` and `test:security` (next to `live-stale-revision`).
- No new root `playwright.config.ts` entry: `session-recovery.spec.ts` uses the
  existing browser-lab server (3860). `playwright.services.config.ts` sets
  `ACCEPTANCE_LOAD_TOOLS=1` on the four replicas.
- ADR 0036 is new; renumber it if another branch also adds 0036.
- Expected conflicts: `packages/live/src/runtime.ts` (admission and
  `executeUntraced`), `live.module.ts` (recovery interceptor, providers),
  `packages/client/src/index.ts` (error handling in `invoke`),
  `packages/cache/README.md` (the cache-tags branch).
- Behaviour change for other branches: realtime-driven refreshes and the
  `STALE_REVISION` resync no longer advance the revision unless the render
  changes stored state. A test that expects a revision bump after an
  invalidation or resync must expect the stored revision instead.
- Changesets: `live-read-only-refresh` (live minor, client and observability
  patch), `live-depends-on` (live minor), `realtime-round5-evidence` (realtime
  patch).
