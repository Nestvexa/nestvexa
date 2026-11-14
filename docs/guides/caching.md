# Caching and state stores

How Nestvexa keeps server-side state (Live state stores) and caches rendered
HTML and data without leaking one user's or tenant's content to another.
Runnable example: [`examples/data-cache`](../../examples/data-cache/README.md).

## Live state stores

| Store                                         | Use                                                | Shared across replicas |
| --------------------------------------------- | -------------------------------------------------- | ---------------------- |
| `MemoryLiveStore` (default)                   | development, one process; bounded, lost on restart | no                     |
| `RedisLiveStore` (`@nestvexa/realtime-redis`) | production replicas                                | yes                    |
| your own `LiveStateStore`                     | any database with conditional updates              | if the backend is      |

### Redis: namespacing, versioning and failure behaviour

```ts
import { RedisLiveStore } from '@nestvexa/realtime-redis';

const store = new RedisLiveStore({
  host: 'redis',
  prefix: 'shop:prod:live:',
  // The host built the binding as `${tenant}/${session}/${userId}`.
  namespace: (binding) => {
    const [tenant, , user] = binding.split('/');
    return { tenant, user };
  },
  encryptionKeys: [key], // only if policy requires encrypting state at rest
});
LiveModule.register({ ...options, store });

// Tenant offboarding and "sign out everywhere":
await store.revokeTenant('acme');
await store.revokeUser('acme', userId);
```

- Keys: `<prefix>t:<tenant>:s:<sha256(token)>` and siblings; tokens, bindings
  and user ids are hashed; only the tenant id is in clear.
- Serialization: versioned JSON records, validated on every read with the
  browser-input limits (prototype keys, non-JSON values and oversized state are
  rejected); optional AES-256-GCM with the key name as associated data and key
  rotation.
- Versioning / compare-and-set: every commit is `WATCH`/`MULTI`/`EXEC` on the
  lease owner and `revision`; stale or replayed revisions fail with
  `409 STALE_REVISION` before the action runs; concurrent actions on any
  replica get `409 COMPONENT_BUSY`.
- At most once: a fence written before the callback and removed by the commit
  makes an attempt whose commit was never recorded (crash, outage, lapsed
  lease) invalidate the entry (`410`) instead of running again.
- Failures: Redis unreachable → `503 STORE_UNAVAILABLE` (client retries later,
  state kept); see the
  [failure table](../../packages/realtime-redis/README.md#failure-behaviour).

### Custom Live state stores

Implement `LiveStateStore` from `@nestvexa/live` (`create`, `peek`,
`transaction`, `revoke`, `delete`, `close`; synchronous or asynchronous):

- identity binding: an entry is readable only with the binding it was created
  for; every failure is the same `LiveProtocolError('INVALID_SNAPSHOT', 410)`;
- lock: one transaction per entry; a concurrent one fails with
  `COMPONENT_BUSY` (409) before its callback runs;
- version: `transaction` accepts only the stored revision and commits
  `revision + 1` atomically (compare-and-set);
- failure: a failed callback invalidates the entry; revoke, delete or expiry
  during a callback is never undone by its commit;
- TTL fixed from creation; tokens are 256-bit bearer references (store hashes).

Prove an implementation with the reusable contract suite:

```ts
import { liveStoreContract } from '@nestvexa/live/testing';

describe('MyStore', () => {
  for (const contract of liveStoreContract(() => ({
    shared: true, // instances see the same entries (false for process-local)
    boundsEntriesPerBinding: true,
    advance: (ms) => clock.advance(ms), // the store must read this clock
    store: ({ ttlMs, maxEntries }) =>
      new MyStore({ ttlMs, maxEntries, now: clock.now }),
    dispose: () => database.drop(),
  })))
    it(contract.name, () => contract.run());
});
```

[`examples/data-cache/src/sqlite-live-store.ts`](../../examples/data-cache/src/sqlite-live-store.ts)
is a complete custom store on SQLite: the lease is one conditional `UPDATE`,
the commit a compare-and-set on revision, lease owner and lease expiry. It
passes the same suite as the memory and Redis stores
([`tests/live-store-contract.test.ts`](../../tests/live-store-contract.test.ts)).

## Render and data caching

`@nestvexa/cache` ([README](../../packages/cache/README.md)):

1. Caching is opt-in per fragment with `RenderCache#render`. The key always
   contains component, revision, renderer, locale, tenant, permission scope and
   asset version; all are required fields.
2. Choose the audience. `private` HTML is never stored by default (status
   `bypass`); `tenant` HTML is shared only by users of one tenant with the same
   permission scope; `public` HTML by everyone.
3. Never cache Live components, CSRF fields or signed islands: such HTML is
   refused (`CacheRefusedError`). Cache the static parts and mount Live
   components per request.
4. Tag fragments with the data they show and call `invalidate(tags)` after a
   write; a render that overlaps the invalidation is not stored.
5. Stale-while-revalidate only for `public` and `tenant` audiences.
6. Wire `onEvent` to metrics and `instrumentation` to tracing; watch `refused`,
   `bypass` and `discarded` counts.
7. Several replicas: use `onInvalidate` to publish the tags (for example
   `tagChannel(tag)` on the realtime broker) and invalidate on every replica.
   Stampede protection is per process.

HTTP caching is separate: pages that contain personal content or Live
components must send `Cache-Control: private, no-store` (the example does).
