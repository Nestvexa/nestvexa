# Data cache and custom store example

A small multi-tenant catalog showing `@nestvexa/cache` render caching and a
custom Live state store.

- **Tenant-shared catalog fragment** (`audience: 'tenant'`): one render per
  tenant, permission scope and locale; `X-Cache-Catalog` shows `miss`, `hit`,
  `stale` or `coalesced`. Alice and Bob share tenant A but not a permission
  scope (only admins see edit links), so they never share HTML; Carol (tenant
  B) never sees tenant A products. `Accept-Language: ar` renders an RTL
  Arabic fragment under its own key.
- **Public footer** (`audience: 'public'`, `tenant: null`, no permissions).
- **Personal account fragment** (`audience: 'private'`): never stored
  (`X-Cache-Account: bypass`), the default for private HTML.
- **Write → invalidation**: adding a product (admins only, re-checked on the
  server, CSRF-protected) invalidates the tag `products:<tenant>` for every
  locale and permission scope of that tenant only.
- **Live cart** mounted per request outside every cached fragment (its HTML
  carries a per-user snapshot and CSRF token; `RenderCache` refuses it). Its
  state lives in [`SqliteLiveStore`](src/sqlite-live-store.ts), an example
  custom `LiveStateStore` on `node:sqlite` that passes the reusable contract
  suite from `@nestvexa/live/testing`.
- `GET /api/cache` (admins): cache metrics, render counts and recent telemetry
  events.

Tenants and roles come from a fixed server-side directory selected at sign-in;
nothing is taken from the client. Sessions use the in-memory express-session
store with a random secret: illustrative only, not a production identity setup.

## Run

```sh
pnpm --filter @nestvexa/example-data-cache... build
PORT=4000 pnpm --filter @nestvexa/example-data-cache start
```

Open http://127.0.0.1:4000 and sign in as Alice, Bob or Carol. Environment:
`PORT` (default 4000), `LIVE_DATABASE` (SQLite file, default
`live-state.db` next to `dist`), `ASSET_VERSION` (enters every render key).
`node:sqlite` prints an ExperimentalWarning on Node 22 and 24.

## Tests

`tests/cache-example.test.ts` drives this application over HTTP (shared vs
separate fragments, bypass of personal HTML, invalidation, viewer write
refused, refusal of the Live page, Live action against the SQLite store and a
foreign identity rejected). `tests/live-store-contract.test.ts` runs the store
contract suite against `SqliteLiveStore`.
