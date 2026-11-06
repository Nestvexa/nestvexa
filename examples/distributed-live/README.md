# Distributed Live example

A Nestvexa Live app built to run as several replicas behind a load balancer.
Each replica shares, through one Redis primary:

- realtime invalidations (`RedisRealtimeBroker`, PUBLISH/SUBSCRIBE);
- Live component state (`RedisLiveStore`), so an action can land on any replica;
- a demo value (a Redis counter) that every replica renders.

Identity is a signed, stateless guest cookie (`nv_guest`, HMAC with the shared
`IDENTITY_SECRET`), so every replica resolves the same identity without a
shared session store. It is illustrative only; production hosts use real
authentication.

```text
browsers ──► load balancer (src/proxy.ts in development)
                ├──► replica a ─┐
                └──► replica b ─┴──► Redis  (rt: pub/sub, live: state, total)
```

## Run standalone (no Redis)

```sh
pnpm build
PORT=3220 pnpm --filter @nestvexa/example-distributed-live start
```

Without `REDIS_PORT` the replica uses the memory broker and memory Live store.

## Run two replicas with Redis

```sh
docker run -d --name nestvexa-redis -p 127.0.0.1:6379:6379 redis:7-alpine
export REDIS_PORT=6379 PUBLIC_ORIGIN=http://127.0.0.1:3222 \
  REALTIME_SECRET=$(openssl rand -base64 48) IDENTITY_SECRET=$(openssl rand -base64 48)
PORT=3220 REPLICA=a REALTIME_TRANSPORT=sse pnpm --filter @nestvexa/example-distributed-live start &
PORT=3221 REPLICA=b REALTIME_TRANSPORT=websocket pnpm --filter @nestvexa/example-distributed-live start &
PROXY_PORT=3222 pnpm --filter @nestvexa/example-distributed-live start:proxy
```

Open `http://127.0.0.1:3222` in two browsers. The development proxy sends a
browser to replica b when its `nv_replica` cookie is `b`, otherwise to a; each
response carries `x-nestvexa-replica`.

| Variable                             | Meaning                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `PORT`, `REPLICA`                    | Listen port (default 3220) and replica name shown on the page      |
| `PUBLIC_ORIGIN`                      | The origin browsers use (the load balancer); same on every replica |
| `REDIS_HOST`, `REDIS_PORT`           | Enables distributed mode                                           |
| `REDIS_PASSWORD`, `REDIS_PREFIX`     | AUTH password; key namespace (default `nvdemo:`)                   |
| `REALTIME_SECRET`, `IDENTITY_SECRET` | ≥32 bytes, identical on every replica (required with Redis)        |
| `REALTIME_TRANSPORT`                 | `auto` (default), `sse`, `websocket` or `polling`                  |

## What it demonstrates

- An increment on replica b publishes `board:public`; browsers subscribed
  through replica a refresh through their own authorized `$sync` on a.
- The component's `clicks` state lives in Redis: start on a, move the browser to
  b, and the next action continues at the next revision. Replayed revisions are
  rejected on every replica.
- Presence: "Viewers connected to this replica" uses
  `RealtimeService.presence`, which is per replica by design.
- Per-identity publish rate limits (`publish(..., { identity })`).

The acceptance suite `tests/services/distributed.spec.ts` (run by
`pnpm test:services` with `NESTVEXA_REDIS_PORT`, see the
[production services guide](../../docs/guides/production-services.md)) drives
exactly this topology. The standalone replica also backs the WebSocket and
`auto`-fallback browser tests in `tests/browser/realtime-transports.spec.ts`.
