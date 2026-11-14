# Deploying Nestvexa applications

A Nestvexa application is an ordinary NestJS process. You deploy it the way you
deploy any Nest app. Nestvexa adds a few requirements on top: process-local
state, an exact public origin, client asset routes and response headers. This
section covers those requirements.

> **Status:** Nestvexa is an experimental alpha (`0.1.0-alpha.0`). These guides
> describe what the packages do today and what the host must provide. The
> repository's own checkpoints run every example as a single process on
> loopback (`127.0.0.1`). The Docker, systemd, nginx and Caddy configurations in
> these pages are generic templates. They have not been run as part of the
> repository test suites. Current verification is recorded in
> [implementation status](../implementation/STATUS.md).

## Guides

| Guide                                                 | Covers                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| [Node process managers](node-process-managers.md)     | `node dist/main.js`, systemd, PM2, graceful shutdown, Inertia SSR process |
| [Docker](docker.md)                                   | Multi-stage image, non-root user, `PORT`, bind address, health check      |
| [Reverse proxies](reverse-proxy.md)                   | nginx/Caddy, TLS, `Origin`, SSE/WebSocket, upload body limits, caching    |
| [Multiple replicas and Redis](multi-replica-redis.md) | Per-process state, sticky sessions, the Redis-protocol realtime broker    |
| [CSP and security headers](csp-and-headers.md)        | Policies for Live/Alpine, Vite/Inertia and islands; nonces; asset CDNs    |

## Production checklist

Work through this list before exposing an application. Each item links to the
page that explains it.

### Build and runtime

- [ ] Node 22.13+ or 24. The packages are ESM-only. CommonJS Nest apps load them
      through `require(esm)`, which needs Node 22.12 or later.
- [ ] Build ahead of time (`nest build` or `tsc`, plus `vite build` and
      `vite build --ssr …` for Inertia apps). Production must not start the Vite
      dev server. `createViteDevServer` refuses to run when
      `NODE_ENV=production` unless you pass `allowInProduction`. See the
      [Vite guide](../guides/vite.md).
- [ ] Set `NODE_ENV=production`. The [CLI](../reference/cli.md)-generated
      session setup uses it to turn on secure cookies. `DevtoolsModule` from
      `@nestvexa/observability` refuses to register in production. Inertia SSR
      bundles need it to load the production builds of React, Vue or Svelte.
- [ ] Enable the compiled-template cache with `views: { cache: true }`.
      Templates are uncached by default. Deploy templates read-only and keep
      them outside every upload directory.
- [ ] Call `app.enableShutdownHooks()`. Uploads use it to remove temporary
      files on `SIGTERM`, and the application-local renderer and asset snapshot
      are disposed through it.

### Secrets and identity

- [ ] Load every secret from the environment or a secret manager, never from
      source. This includes the session secret and the `RealtimeModule`
      `secrets` (1–8 values of at least 32 bytes each, newest first, shared by
      every replica). It also includes S3 credentials and any Redis password.
      `nestvexa doctor` warns about literal `secret:` strings in `main.ts`.
- [ ] Replace the guest identity policy that `nestvexa init` generates.
      `resolveIdentity` must return a binding that covers your authenticated
      session, user and tenant. It must also return a session-bound CSRF
      token. `authorize` must allow `$mount`, `$sync` and each action
      explicitly. See [default Live setup](../guides/default-live-setup.md).
- [ ] Use a persistent session store. The `express-session` default
      `MemoryStore` in the examples is for demonstrations only. Choosing and
      operating a production store is up to the host.
- [ ] Revoke Live and realtime bindings on logout or permission change
      (`RealtimeService.revoke(binding)`, `closeChannel(channel)`).

### Network and origin

- [ ] Configure the exact **public** origin, such as
      `https://app.example.com`, in the Live registration, `RealtimeModule`,
      `UploadsModule` and any Inertia CSRF guard. Live compares the browser's
      `Origin` header to that string exactly. A proxy that rewrites the
      scheme or host does not change what the browser sends. See
      [reverse proxies](reverse-proxy.md#origin-and-csrf).
- [ ] Terminate TLS in front of the app and set `trust proxy` correctly if your
      session cookie is `secure`.
- [ ] Disable proxy buffering for SSE (`<endpoint>/sse`) and Live text-stream
      routes. Allow WebSocket upgrades only if you attach the WebSocket transport.
- [ ] Size proxy body limits for uploads: at least `chunkSize` (default 1 MiB)
      plus headers on chunk routes, and `maxFileSize` on form routes.

### Pages, assets and headers

- [ ] Send `Cache-Control: no-store` on every page that mounts Live components
      or embeds private data. Live responses already send it. Your mount routes
      must send it as well.
- [ ] Send a restrictive Content-Security-Policy. See
      [CSP and security headers](csp-and-headers.md).
- [ ] Serve client assets from the application. Content-addressed Live/Alpine
      assets and hashed Vite files are cached as `immutable`. The Live boot
      script (`/_nestvexa/boot.js`) is `no-store` and must stay that way. See
      [client assets](../guides/client-assets.md).
- [ ] Apply the Multer override (`multer` 2.5.0) to your own lockfile if you use
      `@nestjs/platform-express`. Repository overrides do not transfer to
      consumers. See [hardening](../security/hardening.md).

### Health and operations

- [ ] Add a health route yourself. Nestvexa does not register one. The
      examples use a plain `@Get('api/health')` controller method that returns
      `{ status: 'ok' }`. For Inertia SSR, the official SSR server answers
      `GET /health` on its own port.
- [ ] Decide on your scaling model before adding replicas. Live state, upload
      sessions, the default realtime broker and `JobRunner` live in process
      memory. See [multiple replicas](multi-replica-redis.md).
- [ ] Use the redacting logger from `@nestvexa/observability`. Never log
      cookies, CSRF tokens, Live snapshots, SSE query tokens or presigned URLs.

## Windows local development

The repository is developed and checkpointed on Windows as well as Linux
(Docker, Ubuntu 24.04). Notes for Windows hosts:

- Examples bind `127.0.0.1` and read `PORT`. In PowerShell:
  `$env:PORT = '3400'; pnpm --filter @nestvexa/example-starter-live start`.
- Run `pnpm test:pack` from PowerShell. The README records this requirement
  for the packed-consumer check.
- Vitest runs with one worker on Windows hosts. This is configured in the
  repository and avoids flaky parallel runs there.
- Short (8.3) path forms used to break template-root and Vite allow-list
  checks. Both were fixed during the 2026-11-02 checkpoint, so upgrade before
  you debug an "outside the root" error on Windows.

What has been run: `services.yml` drives four Nest replicas (Express and
Fastify, SSE and WebSocket) through one Redis behind the distributed-live
example's development proxy, plus two showcase instances on the same Redis, in
a real browser ([multiple replicas](multi-replica-redis.md)); `nightly.yml`
runs the load and memory soak and the property and fuzz suites
([property, load and mutation](../testing/property-load-mutation.md)); and
`ci.yml` builds the showcase Docker image ([Docker](docker.md#ci)).

> **Known gap:** no production load balancer has been put in front of the
> replicas (only the example's development proxy), uploads were tested against
> S3-compatible SeaweedFS rather than real AWS S3, and no CDN has been
> configured. The showcase image is built in CI but the Compose stack is not
> started there. An independent security review is still open. See
> [implementation status](../implementation/STATUS.md).
