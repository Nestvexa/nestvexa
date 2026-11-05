# Getting started: APIs and universal server actions

Nestvexa does not take over API routing. REST controllers, WebSocket gateways and
other Nest endpoints keep working unchanged next to MVC, Live and Inertia pages.
When browser code that is not a Live component (a page script, an island) needs
server logic, `@nestvexa/actions` exposes explicitly decorated methods as typed,
authorized routes that still run your Nest guards, pipes, interceptors and
filters.

## API coexistence

What Nestvexa registers, and nothing more (the Inertia interceptor passes
ordinary handler results through untouched, but it does validate `X-Inertia-*`
headers on every HTTP route while registered globally):

| Package              | Routes it adds                                                                                                                     | Global middleware |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `nestvexa` (MVC)     | none; it installs the view engine on the HTTP platform                                                                             | none              |
| `nestvexa` with Live | `POST /_nestvexa/live/...`, `GET /_nestvexa/boot.js`, assets under `/_nestvexa/assets`                                             | none              |
| `@nestvexa/inertia`  | none; a global interceptor and validation filter by default (`interceptor: 'decorated'` limits it to `@InertiaPage`/`@UseInertia`) | none              |
| `@nestvexa/actions`  | `POST /_nestvexa/actions/<group>/<action>` per decorated method                                                                    | none              |

Prefixes are configurable (`endpoint`, `basePath`, `browser.path`). Global API
prefixes and URI or header versioning are honored; the
[default setup guide](../guides/default-live-setup.md#prefixes-and-versions)
explains the `basePath` rules. Sessions, CORS, body parsers, authentication and
security headers remain host-owned. Every example keeps a native JSON route such
as this one from the [HBS starter](../../examples/starter-hbs/src/main.ts):

<!-- snippet: examples/starter-hbs/src/main.ts -->

```ts
  @Get('api/health')
  health() {
    return { status: 'ok', renderer: 'native-nest' };
  }
```

Its responses are asserted alongside Nestvexa routes, including under a global
prefix and URI versioning, in [assets.test.ts](../../tests/assets.test.ts).

## 1. Install server actions

```sh
npm install @nestvexa/actions
```

Peers: Nest 12, `reflect-metadata`, RxJS. `typescript` is an optional peer used
only by the code generator.

## 2. Write an action group

A group is a thin facade over your services. Only `@ServerAction` methods of
registered groups become routes; the subject always comes from the
server-resolved identity, never the request body. From the
[actions example](../../examples/actions-basic/src/cart.ts):

<!-- snippet: examples/actions-basic/src/cart.ts -->

```ts
@Injectable()
@ActionGroup('cart')
@UseGuards(SessionAuthGuard)
export class CartActions {
  constructor(@Inject(CartService) private readonly cart: CartService) {}

  @ServerAction({ id: 'add-item', idempotent: true, concurrency: 'serial' })
  add(
    @ActionInput(AddItemPipe) input: AddItemInput,
    @ActionContext() context: ActionContext,
  ): CartSummary {
    // The owner always comes from the host-resolved identity, never the body.
    return this.cart.add(context.identity.subject, input);
  }
```

## 3. Register it with a host policy

```ts
ActionsModule.register({
  groups: [CartActions],
  imports: [CartModule],
  origin,
  resolveIdentity(request) {
    const value = request as Partial<SessionRequest>;
    if (!value.session?.csrf || !value.sessionID) return null;
    return {
      subject: value.session.userId ?? `guest:${value.sessionID}`,
      tenant: 'demo-store',
      csrfToken: value.session.csrf,
    };
  },
  authorize: (_identity, action) => action.group === 'cart',
});
```

`authorize` runs on every call in addition to group and method guards. Requests
without the session CSRF token, from another origin or with a forged token fail
before your method runs.

## 4. Generate and use the typed client

```sh
npx nestvexa-actions-codegen --project tsconfig.json --out browser/generated
```

The generator reads your action signatures with the TypeScript checker and writes
a frozen manifest plus `.d.ts` types (`--check` fails CI when they are stale). In
the browser:

<!-- snippet: examples/actions-basic/browser/main.ts -->

```ts
const actions = createActions(
  createActionsClient({
    // Defaults read the CSRF token from <meta name="nestvexa-csrf">.
    onNotifications: (notifications) =>
      say(notifications.map((notification) => notification.message).join(' ')),
  }),
);
```

`await actions.cart.addItem({ productId, quantity: 1 })` resolves to the server's
`CartSummary` type (dates as JSON strings). Failures reject with an
`ActionClientError` carrying a stable `code`; use `isActionClientError(error)`.

## 5. Run and test

```sh
pnpm build
pnpm --filter @nestvexa/example-actions-basic start   # http://127.0.0.1:3111
```

The [actions browser spec](../../tests/browser/actions.spec.ts) signs in, calls the
typed client and verifies that guest, CSRF-less, forged-token and cross-origin
calls fail without side effects. Idempotency keys, serial concurrency, timeouts,
validation with pipes or Zod-like schemas, results (`redirectTo`,
`withNotifications`) and error envelopes are covered in the
[server actions guide](../guides/server-actions.md).

> **Known gap:** GraphQL resolvers and Nest microservice transports are expected
> to coexist because Nestvexa registers no global middleware, but no test or
> example exercises them. Server actions have no streaming or `202` job-ticket
> results, no structured per-call logs or tracing spans, and no React/Vue/Svelte
> hooks yet; use the framework-neutral client.
