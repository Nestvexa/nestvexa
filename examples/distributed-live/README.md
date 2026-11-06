# Distributed Live example

A Nestvexa Live app built to run as several replicas behind a load balancer.
Each replica shares, through one Redis primary:

- realtime invalidations (`RedisRealtimeBroker`, PUBLISH/SUBSCRIBE);
- Live component state (`RedisLiveStore`), so an action can land on any replica;
- presence (`RedisPresenceStore`), so every replica counts every viewer;
- a demo value (a Redis counter) that every replica renders.

Identity is a signed, stateless guest cookie (`nv_guest`, HMAC with the shared
`IDENTITY_SECRET`), so every replica resolves the same identity without a
shared session store. It is illustrative only; production hosts use real
authentication.

```text
browsers ──► load balancer (src/proxy.ts in development)
                ├──► replica a (Express) ─┐
                ├──► replica b (Express) ─┤
                ├──► replica c (Fastify) ─┼──► Redis  (rt: pub/sub, live: state,
                └──► replica d (Fastify) ─┘            presence:, total)
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
PORT=3221 REPLICA=b REALTIME_TRANSPORT=websocket HTTP_ADAPTER=fastify pnpm --filter @nestvexa/example-distributed-live start &
PROXY_PORT=3222 pnpm --filter @nestvexa/example-distributed-live start:proxy
```

Open `http://127.0.0.1:3222` in two browsers. The development proxy sends a
browser to replica b, c or d when its `nv_replica` cookie names one (targets
`TARGET_A`..`TARGET_D`), otherwise to a; each response carries
`x-nestvexa-replica`. `POST /__proxy/drop` cuts every open connection, like a
load balancer restart (development only).

| Variable                             | Meaning                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `PORT`, `REPLICA`                    | Listen port (default 3220) and replica name shown on the page      |
| `PUBLIC_ORIGIN`                      | The origin browsers use (the load balancer); same on every replica |
| `REDIS_HOST`, `REDIS_PORT`           | Enables distributed mode                                           |
| `REDIS_PASSWORD`, `REDIS_PREFIX`     | AUTH password; key namespace (default `nvdemo:`)                   |
| `REALTIME_SECRET`, `IDENTITY_SECRET` | ≥32 bytes, identical on every replica (required with Redis)        |
| `REALTIME_TRANSPORT`                 | `auto` (default), `sse`, `websocket` or `polling`                  |
| `HTTP_ADAPTER`                       | `express` (default) or `fastify`                                   |
| `PRESENCE_TTL_MS`                    | Presence entry lifetime with Redis (default 30000)                 |

## What it demonstrates

- An increment on replica b publishes `board:public`; browsers subscribed
  through replica a refresh through their own authorized `$sync` on a.
- The component's `clicks` state lives in Redis: start on a, move the browser to
  b, and the next action continues at the next revision. Replayed revisions are
  rejected on every replica.
- Presence: "Viewers connected" uses `RealtimeService.presence`; with Redis it
  merges every replica's viewers, and a crashed replica's viewers lapse after
  `PRESENCE_TTL_MS`.
- The same app on Express and Fastify replicas; `/api/health` reports the
  adapter, the transports offered and this replica's open connections.
- Per-identity publish rate limits (`publish(..., { identity })`).

The acceptance suite `tests/services/distributed.spec.ts` (run by
`pnpm test:services` with `NESTVEXA_REDIS_PORT`, see the
[production services guide](../../docs/guides/production-services.md)) drives
exactly this topology with four replicas. Standalone replicas also back the
WebSocket, polling, `auto` negotiation and fallback (WebSocket → SSE →
polling) and Fastify browser tests in `tests/browser/realtime-transports.spec.ts`.
