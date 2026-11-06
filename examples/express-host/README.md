# Express host

One Nestvexa application, two Nest HTTP platforms. This example runs it on
`@nestjs/platform-express`; [`examples/fastify-host`](../fastify-host/README.md)
runs the **byte-identical** `src/app.ts` and `views/` on
`@nestjs/platform-fastify`. Only `src/main.ts` differs. A unit test
(`tests/examples-hosts.test.ts`) fails if the two copies drift apart, and one
shared browser suite (`tests/browser/host-adapter-suite.ts`) runs the same
assertions against both servers.

## What it shows

| Route                 | What it proves                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`               | HBS layout and escaping through `NestvexaModule`, a Live counter and a validated Live guestbook that update without a full reload. |
| `GET /about`          | An ordinary `@Render` route next to the Live endpoints.                                                                            |
| `GET /api/notes/:id`  | Native Nest API: API-key guard, `ParseIntPipe`, envelope interceptor and an exception filter that formats errors.                  |
| `POST /api/notes`     | A body validation pipe that rejects unknown keys.                                                                                  |
| `GET /api/health`     | Names the active platform (`express` here).                                                                                        |
| `/_nestvexa/live/...` | The Live endpoints registered by the integrated setup (`live: { enabled: true }`).                                                 |

The shared module never imports Express or Fastify. It reads requests through
`request.headers` and writes responses through Nest's `HttpAdapterHost`
(`setHeader`, `reply`). Identity is an HMAC-signed guest cookie instead of a
platform-specific session middleware, so the same code works on both adapters.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm build                     # or: pnpm --filter @nestvexa/example-express-host... build
pnpm --filter @nestvexa/example-express-host start   # http://127.0.0.1:3120
```

`PORT` overrides the port (the origin check follows it). `GUEST_COOKIE_SECRET`
(at least 32 bytes) makes guest cookies survive restarts; without it a random
per-process secret is used. `pnpm --filter @nestvexa/example-express-host dev`
runs the TypeScript source with `tsx`.

Try the API:

```sh
curl -H 'x-api-key: demo-key-not-a-secret' http://127.0.0.1:3120/api/notes/1
curl http://127.0.0.1:3120/api/notes/1            # 401, formatted by the filter
```

## Tests

The root Playwright suite starts this example on port **3120**
(`tests/browser/express-host.spec.ts`; override the URL with
`NV_E2E_EXPRESS_HOST_URL`). It covers rendering, the HttpOnly/SameSite cookie,
Live actions and validation without reload, per-guest data isolation, Live
negative cases (missing CSRF, wrong origin, forged cookie, a snapshot replayed
by another guest), the native guard/pipe/interceptor/filter responses and axe
WCAG 2.1 A/AA scans.

## Security notes

- The guest cookie is `HttpOnly; SameSite=Strict`, signed with HMAC-SHA256 and
  verified in constant time. The Live CSRF token is a separate HMAC of the same
  guest id. Neither is derived from request bodies.
- It is an anonymous demonstration identity, not authentication. Production
  hosts bind Live to their real session or user, add `Secure` cookies over
  HTTPS, use a stable rotated secret and add resource-level authorization.
- `authorize` allowlists every component action; `$sync` is allowed only for the
  guestbook, whose single writable field has a length bound.
- The API key is a public demonstration value, not a secret.
- State (guestbook, notes) lives in process memory, bounded, and is lost on
  restart. It is not shared between replicas.
- The CSP is `script-src 'self'` with no inline scripts or styles.
