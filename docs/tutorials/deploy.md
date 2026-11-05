# Tutorial: deploy an app

You will take a Nestvexa app (for example one built in the
[CRUD tutorial](crud-app.md)) from `npm run dev` to a production process behind a
reverse proxy. This page is the end-to-end checklist; each step links to a
deployment guide with the details:

| Guide                                                                | Covers                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Node process managers](../deployment/node-process-managers.md)      | Running `node dist/main.js` under systemd, PM2 and similar |
| [Docker](../deployment/docker.md)                                    | Multi-stage images, non-root users, read-only views        |
| [Reverse proxies](../deployment/reverse-proxy.md)                    | TLS, proxy trust, SSE and upload buffering, prefixes       |
| [Multiple replicas with Redis](../deployment/multi-replica-redis.md) | Sticky sessions, the realtime broker, what is per process  |
| [CSP and security headers](../deployment/csp-and-headers.md)         | Nonces, `connect-src`, `no-store` on private pages         |

> **Known gap:** this is an experimental alpha (`0.1.0-alpha.0`). No load,
> memory or soak test and no independent security review have been run (see
> [implementation status](../implementation/STATUS.md)). Plan your own
> capacity and security testing before production traffic.

## 1. Replace the demonstration policies

The examples and `nestvexa init` use a guest session with a random in-process
secret. Before deploying:

- Use real authentication and a **persistent session store**, with a stable
  `SESSION_SECRET` from your secret manager and `cookie: { secure: true, httpOnly: true, sameSite: 'lax' | 'strict' }`.
- Derive the Live `resolveIdentity` binding from authenticated session, user and
  tenant, and keep the CSRF token in the session. Never read identity from the
  request body.
- Set `origin` (Live, actions, uploads, realtime) to the exact public origin,
  for example `https://app.example.com`.
- Give realtime a stable secret list (`REALTIME_SECRET`), not
  `randomBytes()` per process.
- Restrict `authorize` to the components and actions each user may call.

The [security guide](../security/guide.md) explains each of these boundaries.

## 2. Build

```sh
npm ci
npm run build          # or: npx nestvexa build (runs the project build script)
npx nestvexa doctor    # checks Node/Nest versions, nvScripts, configureNestvexa, sessions
```

`doctor` exits 1 on failure and never prints secrets it finds; run it in CI.
Inertia apps also build their Vite client (and SSR bundle when used); see the
[Vite guide](../guides/vite.md).

## 3. Configure for production

- Turn on the compiled-template cache for immutable deployed views:
  `NestvexaModule.forRoot({ views: { root, layout: 'layout', cache: true }, … })`.
- Keep `await configureNestvexa(app)` (and `await configureUploads(app)` when
  using uploads) before `app.listen()`.
- Call `app.enableShutdownHooks()` so Live, realtime, upload sweeps and view
  engines dispose cleanly on `SIGTERM`.
- Read `PORT` from the environment and listen on the interface your proxy reaches.
- Keep a native health route such as `/api/health`; Nestvexa does not take over
  API routing.
- Store uploads outside any served directory, on a persistent volume or
  `S3Storage`.

## 4. Run the process

Start `node dist/main.js` under a supervisor that restarts on failure and sends
`SIGTERM` on stop. Live component state, pending upload tokens and in-process
jobs are held in memory: a restart invalidates open pages (they fail closed and
the browser must reload) and loses queued `JobRunner` work. See
[Node process managers](../deployment/node-process-managers.md) or
[Docker](../deployment/docker.md).

## 5. Put a reverse proxy in front

Terminate TLS at the proxy, configure Nest/Express proxy trust for exactly that
hop, forward `Host`/`Origin` unchanged, and disable response buffering for the
SSE route (`/_nestvexa/realtime/sse`) and text streams. Nestvexa already sends
`X-Accel-Buffering: no` on those responses. Allow request bodies large enough for
your upload `chunkSize`. If the proxy adds a path prefix, configure `basePath`
as described in [client assets](../guides/client-assets.md#prefixes-and-api-versioning).
Details: [reverse proxies](../deployment/reverse-proxy.md).

## 6. Send security headers

Send a restrictive CSP on every HTML page. The Live client and Alpine CSP build
work with `script-src 'self'`; add `connect-src 'self'` for realtime. Use
`{{nvScripts nonce=cspNonce}}` with a host-generated nonce if your policy uses
nonces. Private pages carrying Live mount tokens need `Cache-Control: no-store`.
See [CSP and security headers](../deployment/csp-and-headers.md).

## 7. Scale out (optional)

Running more than one replica requires sticky sessions for Live, uploads and jobs,
and `RespRealtimeBroker` so realtime publishes reach every replica. See
[multiple replicas with Redis](../deployment/multi-replica-redis.md).

> **Known gap:** there is no shared Live state store (DATA-004, DATA-005), and two
> replicas serving one browser through Redis has not been tested end to end
> (REAL-014).

## 8. Verify the deployment

- Load a Live page, run an action and confirm the response is `201` with no
  console CSP violations.
- Confirm a cross-origin `POST` to `/_nestvexa/live/<component>/<action>` is
  rejected and that a second browser session cannot reuse the first one's
  snapshot.
- Open two sessions on a realtime page and check updates arrive through the proxy.
- Restart the process and confirm open pages fail closed instead of acting on
  stale state.
