# @nestvexa/cache

Privacy-scoped read-through cache for rendered fragments and data: render keys
that always include renderer, locale, tenant, permission scope, asset version
and component revision; no storage of private per-user HTML by default; tag
invalidation; per-key single-flight stampede protection; stale-while-revalidate
for non-personal entries only; telemetry events and spans; and refusal of values
that carry Live snapshots, CSRF tokens or signed island props. Optional; not part
of the default `nestvexa` install. No runtime dependencies.

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

## Rendered fragments

```ts
import { Cache, MemoryCacheStore, RenderCache, tagChannel } from '@nestvexa/cache';

const cache = new Cache({
  store: new MemoryCacheStore(5000),
  onEvent: (event) => metrics.count(`cache.${event.type}`),
  instrumentation, // for example the @nestvexa/observability OpenTelemetry bridge
  onInvalidate: (tags) =>
    Promise.all(tags.map((tag) => realtime.publish(tagChannel(tag)))),
});
const renders = new RenderCache(cache); // { cachePrivate: false } by default

const { html, status } = await renders.render(
  {
    component: 'catalog',
    revision: 'v3', // bump when the template or its data shape changes
    renderer: 'hbs',
    locale, // negotiated server-side
    tenant: user.tenant, // resolved server-side, or null
    permissions: user.permissions, // order-insensitive
    assetVersion: manifestHash,
    vary: { page },
    audience: 'tenant', // 'public' | 'tenant' | 'private'
    ttlMs: 60_000,
    staleWhileRevalidateMs: 30_000,
    tags: [`products:${user.tenant}`],
  },
  () => engine.render('catalog', model),
);
reply.header('X-Cache', status); // hit | miss | stale | coalesced | bypass

// After a write:
await renders.invalidate([`products:${user.tenant}`]);
```

Every context field is required, so a key never silently omits one: pass
`tenant: null` or `permissions: []` when output really does not depend on them.

| Audience  | Stored                                  | Shared by                            | Stale-while-revalidate |
| --------- | --------------------------------------- | ------------------------------------ | ---------------------- |
| `public`  | yes                                     | everyone (the tenant is still keyed) | yes                    |
| `tenant`  | yes                                     | one tenant and permission scope      | yes                    |
| `private` | **no** (`bypass`) unless `cachePrivate` | one identity binding and tenant      | refused                |

Live components, forms with CSRF fields and signed islands must be rendered
outside cached fragments: values containing `data-nv-snapshot`, `data-nv-csrf`,
`data-nv-props-token`, a `_csrf`/`csrf-token` field or a Live `StateSnapshot`
object are refused with `CacheRefusedError` in every audience, for the caller
and every coalesced waiter, and are never stored.

## Data

```ts
const orders = await cache.get(
  {
    namespace: 'data:orders',
    scope: { kind: 'private', binding: identity.binding, tenant: 'tenant-a' },
    vary: { locale, page },
  },
  { ttlMs: 30_000, tags: ['orders:tenant-a'] },
  () => repository.listOrders(tenantId, page),
);
```

Scopes: `{ kind: 'public' }`, `{ kind: 'tenant', tenant }` (shared within a
tenant, never personal) and `{ kind: 'private', binding, tenant? }`.
`cache.lookup(...)` also returns the status. A Live component that declares
`@RealtimeChannels() channels() { return [tagChannel('orders:tenant-a')]; }`
refreshes when that tag is invalidated (see `@nestvexa/realtime`).

## API

| Export                                                                   | Purpose                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `new RenderCache(cache?, { cachePrivate? })`                             | Rendered-HTML cache with required key context                         |
| `RenderCache#render(request, render)`                                    | `{ html, status }`; private HTML bypasses the cache by default        |
| `renderCacheKey(request)` / `renderCacheParts(request)`                  | The key / key parts a render request maps to                          |
| `new Cache({ store?, now?, onInvalidate?, onEvent?, instrumentation? })` | Options form; `new Cache(store?, now?, onInvalidate?)` still works    |
| `Cache#get(parts, { ttlMs, staleWhileRevalidateMs?, tags? }, compute)`   | Read-through with single flight; values must be JSON                  |
| `Cache#lookup(...)`                                                      | Same, returning `{ value, status }`                                   |
| `Cache#invalidate(tags)`                                                 | Delete tagged entries and call the `onInvalidate` hook                |
| `Cache#metrics`                                                          | Hits, misses, stale, coalesced, bypassed, refused, discarded, errors, invalidations |
| `cacheKey({ scope, namespace, vary })`                                   | Deterministic key; tenant/private scopes hash tenant and binding      |
| `cacheableJson(value)`, `CacheRefusedError`                              | JSON serialization with the signed-material refusal                   |
| `MemoryCacheStore(maxEntries = 1000, now?)`                              | Bounded LRU store with a tag index (single process)                   |
| `CacheStore`, `isCacheStore`                                             | Store interface; methods may be synchronous or asynchronous           |
| `tagChannel(tag)`                                                        | Realtime channel name for a data tag                                  |

## Telemetry

`onEvent` receives `hit`, `miss` (with `durationMs`), `stale`, `coalesced`,
`bypass`, `refused`, `discarded`, `compute-error`, `refresh-error`,
`store-error` and `invalidate` (with `tags` and `removed`). Events carry the
namespace and scope kind only: never keys, bindings, tenants or values.
`instrumentation` (structurally `LiveInstrumentation` from
`@nestvexa/observability`) gets one `nestvexa.cache.compute` span per
computation with namespace, scope, reason (`miss`/`refresh`) and duration.
Exceptions thrown by either hook are ignored.

## Security and correctness

- Private values require an identity binding; keys contain only SHA-256 hashes
  of binding and tenant. Bindings with unpaired surrogates are refused (UTF-8
  hashing would merge them). Vary values must be strings, finite numbers,
  booleans or null (NaN would collide with null).
- Single-flight coalescing is per key, so concurrent misses for different
  identities, tenants or permission scopes never share a computation, a value
  or a failure; each caller receives its own JSON copy.
- A computation that overlaps an invalidation of one of its tags returns its
  value but does not store it (no stale write after invalidation).
- Failures are never cached. During stale-while-revalidate a failing refresh
  keeps serving the stale value until `staleUntil` (`refresh-error` event).
- Store failures degrade: a failing `get` computes, a failing `set` returns the
  value without storing (`store-error`); `invalidate` failures propagate.
- `ttlMs` and `staleWhileRevalidateMs` are bounded to 24 hours; SWR is refused
  for private scopes.
- `MemoryCacheStore` is per process; multiple replicas need a shared store and
  cross-replica invalidation (`onInvalidate` → realtime → `invalidate` on each
  replica). Stampede protection is per process: N replicas compute a key at
  most N times concurrently.

See the [caching and stores guide](../../docs/guides/caching.md) and the
runnable [data-cache example](../../examples/data-cache/README.md). MIT licensed.

## Status and limits

Status: **Implemented** for the library API above (tests:
`tests/cache.test.ts`, `tests/cache-render.test.ts`,
`tests/cache-example.test.ts`, `tests/cache-poisoning.test.ts`).

- Render caching is explicit: hosts call `RenderCache#render` around a view;
  the HBS, Live and Inertia pipelines do not cache automatically, and Live
  component HTML can never be cached (by design).
- No shared (Redis) `CacheStore` ships; the interface accepts asynchronous
  stores.
- Dependency tracking is explicit tags only.

## Testing

```sh
pnpm --filter @nestvexa/cache test
```

Build first with `pnpm --filter @nestvexa/cache... build` and
`pnpm --filter @nestvexa/example-data-cache... build` (the tests import `dist`).

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
