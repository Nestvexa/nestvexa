# Fastify host

The application from [`examples/express-host`](../express-host/README.md) on
`@nestjs/platform-fastify`. `src/app.ts` and `views/` are byte-identical copies
(enforced by `tests/examples-hosts.test.ts`); only `src/main.ts` differs:

```ts
const app = await NestFactory.create<NestFastifyApplication>(
  createAppModule({ platform: 'fastify', port, secret }),
  new FastifyAdapter(),
);
await configureNestvexa(app); // registers the Fastify `reply.view` decorator
```

Everything else — HBS rendering, Live components, the guest cookie, the native
guard/pipe/interceptor/filter API — is the same code. See the Express README for
the route table and the full security notes; they apply unchanged.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nestvexa/example-fastify-host start   # http://127.0.0.1:3121
```

`PORT` and `GUEST_COOKIE_SECRET` work as in the Express example.

## Tests

The root Playwright suite starts this example on port **3121**
(`tests/browser/fastify-host.spec.ts`; override with `NV_E2E_FASTIFY_HOST_URL`).
It runs the same shared suite as the Express example, so a behavior difference
between the two platforms fails the build.

## Platform notes

- `configureNestvexa` adds a `reply.view` decorator and refuses to start if
  another plugin already owns it (for example `@fastify/view`).
- No Fastify cookie or session plugin is needed: the shared module sets the
  cookie through `HttpAdapterHost.httpAdapter.setHeader` and reads it from
  `request.headers.cookie`. A real Fastify host would normally use its own
  session plugin and pass that identity to `resolveIdentity`.
- Fastify's built-in JSON body parser handles Live requests with its default
  1 MiB `bodyLimit`. Live requests are small; there is no reason to raise it.
