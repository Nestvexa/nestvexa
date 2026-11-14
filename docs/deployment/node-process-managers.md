# Running under Node process managers

A Nestvexa app is one Node process that runs your compiled Nest entry point.
Nestvexa adds no daemon, worker or sidecar of its own. The one exception is
the optional official Inertia SSR server, which you run as a second process.

> **Known gap:** The systemd and PM2 configurations below are templates. The
> repository runs its examples directly with `node dist/main.js` (or `tsx` in
> development). It does not exercise systemd, PM2 or any other supervisor.

## Standalone Node

Build first, then start the compiled entry point:

```sh
npm run build                    # nest build / tsc (+ vite build for Inertia apps)
NODE_ENV=production PORT=3000 node dist/main.js
```

The examples read `PORT` and bind loopback:

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
const port = Number(process.env['PORT'] ?? 3102);
```

On a host where a reverse proxy runs on the same machine, binding `127.0.0.1`
is correct. Bind `0.0.0.0` only when something outside the host must reach the
port, as in a container. See [Docker](docker.md).

## Graceful shutdown

Call `app.enableShutdownHooks()` before `listen()`, as every example does.
Without it, Nest does not run `onModuleDestroy`/`onApplicationShutdown` on
`SIGTERM`/`SIGINT`, so Nestvexa's cleanup is skipped:

- `@nestvexa/uploads` removes its per-process temporary directory. Pending
  upload sessions are lost either way, because they are in memory.
- The umbrella disposes its shared HBS renderer and clears the client-asset
  snapshot. After that, `getManifest()` rejects.
- `RealtimeService` closes open SSE/WebSocket connections and its broker.
  Browsers then reconnect to another process or wait for the restart.
  `tests/realtime-hub.test.ts` closes a real Nest app and asserts that open
  SSE streams receive `event: close` with reason `shutdown`, the hub is
  empty and the broker is closed with no subscriptions left.
- Live state in `MemoryLiveStore` is discarded. Users with an open page get
  `410` ("Live state is unavailable; reload the page") on their next action.

Plan deployments around that last point. A restart invalidates every open Live
page served by that process. Users must reload. Neither the client nor the
server retries the action automatically.

## systemd

```ini
# /etc/systemd/system/myapp.service — template, not tested by this project
[Unit]
Description=My Nestvexa application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=myapp
WorkingDirectory=/srv/myapp
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/etc/myapp/secrets.env
ExecStart=/usr/bin/node dist/main.js
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/myapp/uploads

[Install]
WantedBy=multi-user.target
```

`ReadWritePaths` must include the uploads `directory` if you use
`@nestvexa/uploads`. Keep templates and `dist/` read-only. Put the session
secret, `RealtimeModule` secrets and storage credentials in the
`EnvironmentFile` with mode `0600`.

## PM2 and cluster mode

PM2 fork mode (one process) works the same as plain Node. **Cluster mode, or
any setup with several processes behind one port, changes behavior.** Several
pieces of state are per process:

| State                              | Where it lives                     | Effect of a request reaching another process     |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Live component state               | `MemoryLiveStore` (the only store) | `410`, page must reload                          |
| Live rate-limit counters           | Per process                        | Each process counts separately                   |
| Upload sessions and pending tokens | `UploadsService` memory            | Session or token not found (`404`)               |
| Realtime events (default broker)   | `MemoryRealtimeBroker`             | Subscribers on other processes are not notified  |
| `JobRunner` jobs                   | Memory                             | Status/cancel unknown elsewhere; lost on restart |
| `express-session` default store    | `MemoryStore`                      | User appears logged out / CSRF mismatch          |

PM2 cluster mode distributes connections round-robin and has no session
affinity. Do not use it with Live, uploads or the in-memory session store.
Run separate fork-mode processes on distinct ports behind a proxy with sticky
sessions instead. [Multiple replicas](multi-replica-redis.md) covers what can
be shared and what cannot.

## Inertia SSR process

The React example runs the official Inertia SSR HTTP server as a second
process, and the Nest host calls it through `HttpSsrGateway`:

```sh
# from examples/inertia-react
node --env-file=ssr.production.env dist/ssr/ssr.js   # POST /render, GET /health
node dist/main.js                                      # SSR_URL defaults to http://127.0.0.1:13716
```

`ssr.production.env` sets `NODE_ENV=production` so that React's production
build loads, and `SSR_PORT=13716`. The repository's browser suite starts this
exact pair and waits for `http://127.0.0.1:13716/health`. Supervise the SSR
server as its own unit with its own restart policy:

- Keep its port private. It renders whatever page object it receives, so only
  the Nest host should reach it.
- `ssr: { mode: 'fallback' }` (the default) serves the client-rendered document
  when the SSR server is down, slow or throws. `mode: 'strict'` returns `500`
  instead. `HttpSsrGateway` defaults to a 5 s timeout. The example uses
  `timeoutMs: 3000`.
- The Vue and Svelte examples render in process with `moduleSsrRenderer`. They
  need no second process, but rendering then shares the Nest event loop.

See the [React](../guides/react.md), [Vue](../guides/vue.md),
[Svelte](../guides/svelte.md) and [Vite](../guides/vite.md) guides.

## Logs

Nest's logger writes to stdout/stderr. Let systemd-journald, PM2 or your
container runtime collect them. Use the redacting logger from
[`@nestvexa/observability`](../guides/observability.md). SSE subscription
tokens travel in the query string, so keep proxy access logs for
`/_nestvexa/realtime/sse` out of shared log sinks.
