# Production services: Redis, S3-compatible storage and clamd

The default test suites use in-process test doubles for Redis pub/sub, S3 and
clamd so they run anywhere. `pnpm test:services` exercises the real services
through the published package code (`dist/`), and writes
`artifacts/reports/services.json`. Only the services whose environment variables
are set are checked; the report names each exercised service and step.

## Start disposable services with Docker

```sh
docker run -d --name nestvexa-redis -p 127.0.0.1:6379:6379 redis:7-alpine
# Any S3-compatible server works; SeaweedFS is used here because public MinIO
# images are no longer distributed on Docker Hub.
docker run -d --name nestvexa-s3 -p 127.0.0.1:9000:8333   -e AWS_ACCESS_KEY_ID=nestvexa -e AWS_SECRET_ACCESS_KEY=nestvexa-secret   chrislusf/seaweedfs server -s3 -s3.port=8333 -dir=/data
docker run -d --name nestvexa-clamd -p 127.0.0.1:3310:3310 clamav/clamav:stable
```

ClamAV downloads its signature database on first start; wait until
`docker logs nestvexa-clamd` reports that clamd is listening.

## Run the checks

```sh
pnpm build
NESTVEXA_REDIS_PORT=6379 NESTVEXA_REDIS_CONTAINER=nestvexa-redis \
NESTVEXA_S3_ENDPOINT=http://127.0.0.1:9000 NESTVEXA_S3_BUCKET=nestvexa-check \
NESTVEXA_S3_ACCESS_KEY=nestvexa NESTVEXA_S3_SECRET_KEY=nestvexa-secret \
NESTVEXA_CLAMD_PORT=3310 pnpm test:services
```

| Service | What is verified                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis   | `RespRealtimeBroker` delivers an event published in one Node process to a subscriber in a second process; with `NESTVEXA_REDIS_CONTAINER`, the container is restarted and delivery resumes afterwards                                                     |
| Redis   | `RedisLiveStore`: state created by one store instance is continued by another; replayed revisions and foreign bindings are rejected; one transaction per entry across instances; revoke during a transaction aborts the commit; `PX` TTL and lease expiry |
| Redis   | `RedisJobQueue`: a job enqueued in one process is claimed by a worker process; idempotency and ownership hold across processes; after the worker is SIGKILLed its lapsed lease is reclaimed and the job completes on attempt 2                            |
| Redis   | `RedisPresenceStore`: entries from two processes merge and stay alive while refreshed; a SIGKILLed process drops out after its `PX` expiry; graceful remove is immediate                                                                                  |
| Redis   | Multi-replica browser acceptance (`playwright.services.config.ts`, `tests/services/distributed.spec.ts`): see below. Skip with `NESTVEXA_SERVICES_BROWSER=0`                                                                                              |
| S3      | `S3Storage` signed PUT, HEAD, GET, Range GET and DELETE; a presigned GET with an attachment disposition; a presigned PUT that rejects a body of the wrong length; a request signed with a wrong secret is rejected                                        |
| clamd   | `ClamdScanner` reports a clean document as clean and the harmless EICAR test string as infected                                                                                                                                                           |

The admin identity creates the bucket on first write. The 2026-11-02 run used
redis:7-alpine, chrislusf/seaweedfs (S3 API 4.50) and clamav/clamav:stable on
Docker Desktop 29.1.3.

## Multi-replica acceptance test

With `NESTVEXA_REDIS_PORT` set, `pnpm test:services` builds nothing itself (run
`pnpm build` first, plus `pnpm exec playwright install chromium` once) and starts
[`examples/distributed-live`](../../examples/distributed-live/README.md) four
times plus its development proxy, all sharing Redis, a fresh key prefix and
random secrets. `NESTVEXA_ACCEPT_BASE_PORT` (default 3220) moves every port:

| Process   | Port    | HTTP adapter | Realtime transport | Role                                                          |
| --------- | ------- | ------------ | ------------------ | ------------------------------------------------------------- |
| replica a | base    | Express      | SSE                | `RedisRealtimeBroker`, `RedisLiveStore`, `RedisPresenceStore` |
| replica b | base +1 | Express      | WebSocket          | same                                                          |
| proxy     | base +2 | —            | —                  | public origin; `nv_replica=b                                  | c   | d`cookie selects;`POST /__proxy/drop` |
| replica c | base +3 | Fastify      | SSE                | same                                                          |
| replica d | base +4 | Fastify      | WebSocket          | same                                                          |

Chromium then verifies that an event published on replica B refreshes a browser
whose SSE stream is held by replica A (and the reverse over B's WebSocket), that
a Live component whose state was created on A continues on B (and a replayed
revision is rejected on A), and that another identity's stolen subscription
token, snapshot or forged cookie is rejected on both replicas. It also checks
that events cross between Express and Fastify replicas over SSE and WebSocket
and Live state continues from Express to Fastify; that presence counts viewers
on all four replicas and drops them when the browsers leave; that after the
proxy drops every connection both an SSE and a WebSocket browser reconnect,
receive new events and never see an event id twice; and that no replica keeps
a connection after its browsers close. The GitHub
workflow `.github/workflows/services.yml` runs the same command against a
`redis:7-alpine` service container. To run only the browser part:

```sh
NESTVEXA_REDIS_PORT=6379 pnpm exec playwright test -c playwright.services.config.ts
```

## Semantics to plan for

- `RedisLiveStore` needs one Redis primary (standalone or Sentinel); Redis
  Cluster is not supported. Every Live action costs about seven round trips, and
  an action that outlives `lockTtlMs` fails closed (the browser reloads).
- Redis pub/sub is fire-and-forget. Events published while a replica is
  disconnected are lost; the broker reconnects with bounded backoff, restores
  its subscriptions, and browsers refresh authoritative state after reconnecting.
  Use a durable queue (`RedisJobQueue`) for work that must not be lost; its
  delivery is at-least-once, so job handlers must be idempotent.
- Credentials stay on the server. Presigned URLs are short-lived bearer tokens:
  keep expiries small and never log them.
- Nestvexa does not ship a malware engine. With a scanner configured, anything
  other than a `clean` verdict blocks finalization.
