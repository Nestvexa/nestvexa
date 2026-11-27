# Cache a rendered fragment

**Goal:** render the expensive parts of a page once and reuse the HTML, without
ever serving one user's or tenant's markup to another. Personal parts and Live
components are rendered per request.

Example: [examples/data-cache](../../examples/data-cache/README.md) (port 4000).

## 1. One cache, one render cache

`Cache` from `@nestvexa/cache` stores entries with tags, single flight and
stale-while-revalidate; `RenderCache` adds the render-specific keys and the
privacy rules on top:

<!-- snippet: examples/data-cache/src/app.ts -->

```ts
  readonly cache = new Cache({
    store: new MemoryCacheStore(500),
    onEvent: (event) => {
      this.events.push(event);
      if (this.events.length > 200) this.events.shift();
    },
  });
  readonly renders = new RenderCache(this.cache);
```

## 2. Declare each fragment's audience and scope

`FragmentCache.renderAll` renders named views through your engine (without the
layout) and returns their HTML plus a hit/miss status per fragment. Each fragment
states who may share it (`audience`), the explicit key inputs (`revision`,
`locale`, `tenant`, `permissions`) and its tags:

<!-- snippet: examples/data-cache/src/app.ts -->

```ts
        catalog: {
          ...scope(current.tenant),
          key: 'catalog',
          view: 'catalog',
          audience: 'tenant',
          ttlMs: 60_000,
          staleWhileRevalidateMs: 30_000,
          tags: [`products:${current.tenant}`],
```

The `model` loader runs only on a miss. A `public` fragment (the footer) has no
tenant and no permissions; a `private` fragment (the account box) carries a
`binding` and is rendered for every request unless the `RenderCache` explicitly
opts in to per-identity storage.

## 3. Invalidate by tag after a write

<!-- snippet: examples/data-cache/src/app.ts -->

```ts
  async addProduct(tenant: string, name: string): Promise<void> {
    this.#products.set(tenant, [...this.products(tenant), name]);
    // Every catalog fragment of this tenant (all locales and permission scopes).
    await this.cache.invalidate([`products:${tenant}`]);
  }
```

The returned HTML is trusted and embedded into the page model; page values stay
escaped.

## Security notes

- Every scope input is required and validated; a fragment cannot be stored
  without stating its audience, tenant and permissions.
- A fragment that contains a Live snapshot is refused and never stored. Mount
  Live components per request, outside cached fragments (the example's cart).
- The deployed asset version is part of every key, so a deploy never serves HTML
  that points at old assets.
- `MemoryCacheStore` is per process.

> **Known gap:** no shared (Redis) `CacheStore` ships. Implement the
> `CacheStore` interface for your store, and fan invalidations out to other
> replicas yourself (`onInvalidate` hook, see
> [multiple replicas](../deployment/multi-replica-redis.md#cache-invalidation-across-replicas)).

## Tests

- [tests/cache-fragments.test.ts](../../tests/cache-fragments.test.ts): layout-free
  fragments, hits that skip the model, private fragments never stored by
  default, every scope input in the key, and refusal of Live snapshots.
- [tests/cache-example.test.ts](../../tests/cache-example.test.ts): the example
  end to end (`X-Cache-*` headers, tenant isolation, invalidation).
- [tests/cache-poisoning.test.ts](../../tests/cache-poisoning.test.ts) and
  [tests/cache-render.test.ts](../../tests/cache-render.test.ts): poisoned
  records and render-cache privacy.

See also: [caching guide](../guides/caching.md#render-and-data-caching).
