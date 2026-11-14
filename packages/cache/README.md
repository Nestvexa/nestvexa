# @nestvexa/cache

Privacy-scoped read-through cache for rendered fragments and data, with tag
invalidation, single-flight stampede protection, stale-while-revalidate for public
data only, and a conservative bridge from data tags to realtime channels. Optional;
not part of the default `nestvexa` install. No runtime dependencies.

## Install

Not published yet: build local tarballs with `pnpm build && pnpm test:pack` and
install the packed `.tgz` file. Future registry syntax:

```sh
npm install @nestvexa/cache
pnpm add @nestvexa/cache
yarn add @nestvexa/cache
```

Node 22.13+ or 24, ESM. No peers and no Nest dependency; it works in any Node
process. It does not depend on `@nestvexa/realtime`; the `onInvalidate` hook is
where you connect a realtime publisher.

## Usage

```ts
import { Cache, MemoryCacheStore, tagChannel } from '@nestvexa/cache';

const cache = new Cache(new MemoryCacheStore(5000), Date.now, (tags) =>
  Promise.all(tags.map((tag) => realtime.publish(tagChannel(tag)))),
);

const orders = await cache.get(
  {
    namespace: 'data:orders',
    scope: { kind: 'private', binding: identity.binding, tenant: 'tenant-a' },
    vary: { locale, page },
  },
  { ttlMs: 30_000, tags: ['orders:tenant-a'] },
  () => repository.listOrders(tenantId, page),
);

// After a write:
await cache.invalidate(['orders:tenant-a']);
```

A Live component that declares `@RealtimeChannels() channels() { return [tagChannel('orders:tenant-a')]; }`
refreshes when that tag is invalidated (see `@nestvexa/realtime`). With
`@nestvexa/live`, declare `@DependsOn('orders:tenant-a')` instead and pass
`LiveTags.listener` as the `onInvalidate` hook; the shape is structural, so neither
package imports the other (`tests/live-dependencies.test.ts`).

## API

| Export                                                                 | Purpose                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `cacheKey({ scope, namespace, vary })`                                 | Deterministic key; private scopes hash binding + tenant |
| `new Cache(store?, now?, onInvalidate?)`                               | Defaults: `MemoryCacheStore`, `Date.now`, no hook       |
| `Cache#get(parts, { ttlMs, staleWhileRevalidateMs?, tags? }, compute)` | Read-through with single flight; values must be JSON    |
| `Cache#invalidate(tags)`                                               | Delete tagged entries and call the `onInvalidate` hook  |
| `Cache#metrics`                                                        | Hits, misses, stale serves, coalesced computations      |
| `MemoryCacheStore(maxEntries = 1000, now?)`                            | Bounded LRU store with a tag index (single process)     |
| `CacheStore`                                                           | Synchronous interface for custom stores                 |
| `tagChannel(tag)`                                                      | Realtime channel name for a data tag                    |

## Security and correctness

- Private values require an identity binding; the key contains only a SHA-256 of
  binding and tenant, never the raw binding. Bindings with unpaired surrogates
  are refused: UTF-8 hashing would map them all to U+FFFD and merge keys.
- Single-flight coalescing is per key, so concurrent misses for different
  identities or tenants never share a computation, a value or a failure; each
  caller receives its own copy.
- Include everything the output depends on in `vary` (locale, permission set,
  renderer, asset version, component revision). Missing vary inputs cause wrong
  content, so prefer short TTLs and do not cache per-user HTML unless required.
- Stale-while-revalidate is rejected for private entries; `ttlMs` must be 1 ms
  to 24 hours.
- Values are cloned through JSON on write and read; callers cannot mutate entries.
- Never cache signed Live snapshots or CSRF tokens.
- `MemoryCacheStore` is per process; multiple replicas need a shared store and
  cross-replica invalidation (for example realtime with `RespRealtimeBroker`).

See the [realtime guide](../../docs/guides/realtime.md) for the tag-to-channel
bridge. MIT licensed.

## Status and limits

Status: **Partial**. The keyed, tagged, single-flight cache with public-only
stale-while-revalidate works and is unit-tested.

- It is a library, not wired into the HBS, Live or Inertia render pipeline;
  renderer, locale, permission scope, asset version and component revision enter
  the key only when the caller passes them in `vary` (DATA-006).
- No runnable example demonstrates it yet, and there is no telemetry beyond the
  in-process `metrics` counters (DATA-007).
- `CacheStore` is synchronous, so a network store such as Redis cannot implement
  it directly; no shared store ships.
- Dependency tracking is explicit tags only; there is no automatic dependency
  detection.

## Testing

```sh
pnpm --filter @nestvexa/cache test
```

Runs `tests/cache.test.ts` (scope isolation, coalescing, expiry, stale serves,
tag invalidation and LRU eviction); build first with
`pnpm --filter @nestvexa/cache... build` because the tests import `dist`.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
