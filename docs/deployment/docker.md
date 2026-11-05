# Docker images

This page shows a multi-stage image for a Nest application that uses
`nestvexa`. It builds with the toolchain, then runs on a slim runtime as a
non-root user.

> **Known gap:** This Dockerfile is a template for your application. It is not
> built or run by the repository's suites. The project's Linux checkpoint does
> run inside Docker (Ubuntu 24.04, Node 24), but as a test environment, not as
> a packaged application image. Real services (Redis, SeaweedFS S3, ClamAV)
> were run in Docker only for `pnpm test:services`. See
> [production services](../guides/production-services.md).

## Bind address and `PORT`

Every example binds loopback and reads `PORT`:

<!-- snippet: examples/live-counter/src/main.ts -->

```ts
const port = Number(process.env['PORT'] ?? 3101);
```

Inside a container, `127.0.0.1` is the container's own loopback, so a
published port cannot reach it. Make the bind host configurable in your
application and set it to `0.0.0.0` in the image:

```ts
const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';
app.enableShutdownHooks();
await app.listen(port, host);
```

Binding `0.0.0.0` exposes the port on every container interface. Publish it
only to the proxy network, or to `127.0.0.1` on the host
(`-p 127.0.0.1:3000:3000`).

## Dockerfile (pnpm)

```dockerfile
# syntax=docker/dockerfile:1 — template, not built by this repository
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
# Templates are trusted code: copy them read-only. Adjust to your views root.
COPY --from=build --chown=root:root /app/src/views ./src/views
RUN mkdir -p /var/lib/myapp/uploads && chown node:node /var/lib/myapp/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

With npm, replace the install lines with `npm ci` and `npm prune --omit=dev`.

Notes:

- **Non-root.** The official Node images include a `node` user. The
  application files are owned by root, so the process cannot rewrite its own
  code or templates. Only the uploads directory is writable.
- **Health check.** Nestvexa does not register a health route. The check
  above calls a route you define, like the examples' `@Get('api/health')`. It
  uses Node's built-in `fetch`, so the slim image needs no `curl`.
- **Views.** Copy the directory your `views.root` resolves to. The examples
  resolve views relative to the compiled file (`new URL('../views',
import.meta.url)`), so they are not under `src/`. Turn on
  `views: { cache: true }` in production.
- **Signals.** `CMD ["node", …]` in exec form makes Node PID 1, so `SIGTERM`
  reaches Nest and `enableShutdownHooks()` runs. If you wrap the command in a
  shell script, `exec` the final command.
- **Multer override.** If you use `@nestjs/platform-express`, add the
  `multer` 2.5.0 override to your own `package.json`/`pnpm-workspace.yaml`
  before `pnpm install` in the build stage. See
  [hardening](../security/hardening.md).
- **Secrets.** Pass the session secret, `RealtimeModule` secrets and storage
  credentials at run time (`--env-file`, orchestrator secrets). Do not bake
  them into the image or set them with `ARG`/`ENV`.

## Inertia apps

Inertia images also need the Vite outputs. The example builds use
`dist/client` for the browser and `dist/ssr` for SSR. Copy both if they live
outside `dist/` in your layout. `@nestvexa/vite` never imports `vite` in
production mode, so `vite` and its plugins can stay devDependencies and be
pruned.

To use the official SSR server as a separate process, run a second container
from the same image with `CMD ["node", "dist/ssr/ssr.js"]` and
`NODE_ENV=production`. Keep its port (13714 by default for
`startOfficialSsrServer`, 13716 in the React example) on an internal network.
Point the Nest container at it, for example with
`new HttpSsrGateway({ url: process.env.SSR_URL })`. See
[process managers](node-process-managers.md#inertia-ssr-process).

## Writable state and volumes

| Path                                 | Needs                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| uploads `directory` (`LocalStorage`) | Persistent volume, private (never under a public static root) |
| `<directory>/tmp/<pid-random>/`      | Created by the process; removed on graceful shutdown          |
| everything else                      | Read-only; set `--read-only` on the container if you can      |

When you use `S3Storage`, finished uploads go to the bucket. Temporary chunks
are still written under `directory`, so it must stay writable. With
`--read-only`, mount a volume or `tmpfs` there.

## Compose sketch with Redis

```yaml
# template — two replicas need sticky sessions; see multi-replica-redis.md
services:
  app:
    build: .
    env_file: ./secrets.env # SESSION_SECRET, REALTIME_SECRET, ...
    environment:
      REDIS_HOST: redis
    depends_on: [redis]
  redis:
    image: redis:7-alpine
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD}']
```

Read [multiple replicas and Redis](multi-replica-redis.md) before you scale
`app` beyond one container. Redis delivers realtime events between replicas,
but it does not share Live state or upload sessions.
