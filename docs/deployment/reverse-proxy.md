# Reverse proxies

Run Nestvexa behind a TLS-terminating proxy such as nginx, Caddy or a cloud
load balancer. Most of the setup is standard. This page covers the parts that
Nestvexa depends on: the browser's `Origin`, streaming responses, WebSocket
upgrades, request body sizes and asset caching.

> **Known gap:** The nginx and Caddy configurations below are templates. They
> are not run by the repository's suites. Those suites connect browsers
> directly to each example on `127.0.0.1`.

## Origin and CSRF

Live action and `_sync` routes reject a request unless its `Origin` header
equals the configured `origin` string **exactly**. The uploads routes and the
realtime WebSocket upgrade apply the same exact-origin rule. (The Inertia
examples protect mutations with an `XSRF-TOKEN` cookie and header instead.) A proxy does not change the `Origin` header the
browser sends, so:

- Configure the public origin (`https://app.example.com`), not the internal
  upstream (`http://127.0.0.1:3000`).
- Each registration takes one origin. One application served under several
  public hostnames needs a separate deployment per hostname, or a host-level
  redirect to one canonical hostname.
- Live does not read `Host`, `X-Forwarded-Host` or `X-Forwarded-Proto` for this
  check. Proxy trust settings therefore have no effect on it.

`trust proxy` still matters for things the host owns. With TLS terminated at
the proxy, `express-session` only sets a `secure` cookie when Express trusts
`X-Forwarded-Proto`:

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.set('trust proxy', 1); // exactly one trusted hop: your proxy
```

Set the number of hops to match your topology. Never use `true` on a host that
is directly reachable, because clients can then forge `X-Forwarded-*` headers.
For Fastify, pass `trustProxy` to the `FastifyAdapter` constructor.

## Public path prefixes

If the proxy mounts the app under a prefix such as `/app`, generated URLs must
include it. Set `basePath` on the Live registration (and `browser.basePath`
when Live routes are URI-versioned) and on `NestvexaAssetsModule.register()`.
The proxy can strip the prefix or pass it through to an
`app.setGlobalPrefix('app')` host. `basePath` only changes generated URLs, not
Nest routing. See [default Live setup](../guides/default-live-setup.md#prefixes-and-versions)
and [client assets](../guides/client-assets.md#prefixes-and-api-versioning).

## Streaming: SSE and text streams

Realtime SSE (`GET <endpoint>/sse`, default `/_nestvexa/realtime/sse`) and
Live text streams send `X-Accel-Buffering: no`, which nginx honours. Other
proxies need buffering disabled per route. Both also send `no-store`. Keep idle
timeouts above the SSE heartbeat (`limits.heartbeatMs`, default 15 s).

Do not compress these responses. A compressing proxy or Express `compression()`
middleware buffers output until a block fills, which delays every event.
Exclude `text/event-stream` and your text-stream routes from compression.

## WebSocket transport

The WebSocket transport is opt-in (`attachRealtimeWebSocket(app)`, `ws` peer)
and listens at `<endpoint>/ws`. It requires `resolveUpgradeIdentity` and an
exact `Origin` match. Session middleware does not run on upgrade requests. Proxy
the upgrade only if you enabled it.

## nginx

```nginx
# template, not tested by this project
upstream myapp { server 127.0.0.1:3000; keepalive 32; }

server {
  listen 443 ssl;
  http2 on;
  server_name app.example.com;
  # ssl_certificate / ssl_certificate_key ...

  client_max_body_size 2m;  # >= uploads chunkSize (1 MiB) + headers

  location / {
    proxy_pass http://myapp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
  }

  location /_nestvexa/realtime/sse {
    proxy_pass http://myapp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    gzip off;
    proxy_read_timeout 1h;
    access_log off;  # subscription tokens are in the query string
  }

  location /_nestvexa/realtime/ws {   # only with attachRealtimeWebSocket
    proxy_pass http://myapp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
  }

  location /uploads-form {           # your multipart form route
    proxy_pass http://myapp;
    client_max_body_size 6m;         # >= the purpose's maxFileSize
    proxy_request_buffering off;
  }
}
```

## Caddy

```caddyfile
# template, not tested by this project
app.example.com {
  request_body {
    max_size 2MB
  }
  @sse path /_nestvexa/realtime/sse
  reverse_proxy @sse 127.0.0.1:3000 {
    flush_interval -1
  }
  reverse_proxy 127.0.0.1:3000
}
```

Caddy proxies WebSocket upgrades automatically. It flushes `text/event-stream`
responses right away, and `flush_interval -1` makes that explicit. Do not add
`encode` for streaming routes.

## Upload body limits

`@nestvexa/uploads` enforces its own limits while streaming. It refuses an
oversized declared `Content-Length` before reading the body, and it refuses
any `Content-Encoding` on request bodies. The proxy must still let legitimate
bodies through:

| Route                                                                     | Allow at least                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PUT /_nestvexa/uploads/sessions/:id/chunks/:index`                       | `chunkSize` (default 1 MiB) plus headers                         |
| `POST /_nestvexa/uploads/files` (raw body) and your multipart form routes | the largest `maxFileSize` plus multipart overhead                |
| Live actions/`_sync`                                                      | Your host JSON body-parser limit; Live state is capped at 64 KiB |

Configure Nest/Express body-parser limits in the app as well. Live requires
those limits to be in place before parsing.

## Asset caching

| Response                                     | Cache policy sent by Nestvexa                | Proxy/CDN                  |
| -------------------------------------------- | -------------------------------------------- | -------------------------- |
| `/_nestvexa/assets/<sha256>/<file>`          | `public, max-age=31536000, immutable` + ETag | Safe to cache              |
| `/_nestvexa/boot.js`                         | `no-store`                                   | Must not cache             |
| Vite hashed files via `viteStaticMiddleware` | one year, `immutable`; non-hashed revalidate | Safe to cache hashed files |
| Live, uploads, realtime responses            | `no-store`                                   | Must not cache             |
| Your pages that mount Live components        | Set `Cache-Control: no-store` yourself       | Must not cache             |

Asset URLs change with content, and a restarted process serves only its
current snapshot. Pages cached from before a deployment may reference asset
versions that no longer exist. Keep HTML uncached so that pages and assets stay
consistent.
