# @nestvexa/cache

Privacy-scoped read-through cache for rendered fragments and data, with tag
invalidation, single-flight stampede protection, stale-while-revalidate for public
data only, and a conservative bridge from data tags to realtime channels. Optional;
not part of the default `nestvexa` install. No runtime dependencies.

## Install

```sh
npm install @nestvexa/cache
```

Node 22.13+ or 24. Works in any Node process; no Nest dependency.

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
refreshes when that tag is invalidated (see `@nestvexa/realtime`).

## API

| Export                                                                 | Purpose                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `cacheKey({ scope, namespace, vary })`                                 | Deterministic key; private scopes hash binding + tenant |
| `Cache#get(parts, { ttlMs, staleWhileRevalidateMs?, tags? }, compute)` | Read-through with single flight; values must be JSON    |
| `Cache#invalidate(tags)`                                               | Delete tagged entries and call the `onInvalidate` hook  |
| `Cache#metrics`                                                        | Hits, misses, stale serves, coalesced computations      |
| `MemoryCacheStore(maxEntries, now?)`                                   | Bounded LRU store with a tag index (single process)     |
| `CacheStore`                                                           | Interface for custom stores (for example Redis)         |
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
- Stale-while-revalidate is rejected for private entries.
- Values are cloned through JSON on write and read; callers cannot mutate entries.
- Never cache signed Live snapshots or CSRF tokens.
- `MemoryCacheStore` is per process; multiple replicas need a shared store and
  cross-replica invalidation (for example realtime with `RespRealtimeBroker`).

## Testing

```sh
pnpm --filter @nestvexa/cache build && pnpm vitest run tests/cache.test.ts
```

License: MIT.
