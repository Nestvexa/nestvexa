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

| Service | What is verified                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redis   | `RespRealtimeBroker` delivers an event published in one Node process to a subscriber in a second process; with `NESTVEXA_REDIS_CONTAINER`, the container is restarted and delivery resumes afterwards              |
| S3      | `S3Storage` signed PUT, HEAD, GET, Range GET and DELETE; a presigned GET with an attachment disposition; a presigned PUT that rejects a body of the wrong length; a request signed with a wrong secret is rejected |
| clamd   | `ClamdScanner` reports a clean document as clean and the harmless EICAR test string as infected                                                                                                                    |

The admin identity creates the bucket on first write. The 2026-11-02 run used
redis:7-alpine, chrislusf/seaweedfs (S3 API 4.50) and clamav/clamav:stable on
Docker Desktop 29.1.3.

## Semantics to plan for

- Redis pub/sub is fire-and-forget. Events published while a replica is
  disconnected are lost; the broker reconnects with bounded backoff, restores
  its subscriptions, and browsers refresh authoritative state after reconnecting.
  Use a durable queue for work that must not be lost.
- Credentials stay on the server. Presigned URLs are short-lived bearer tokens:
  keep expiries small and never log them.
- Nestvexa does not ship a malware engine. With a scanner configured, anything
  other than a `clean` verdict blocks finalization.
