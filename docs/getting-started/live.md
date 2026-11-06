# Getting started: Live components

A Live component is a Nest-resolved class whose public state renders through a
template. The browser runtime sends actions and model updates to generated Nest
routes, the server re-renders the component and the client morphs only the
changed DOM. State stays on the server; the browser holds an opaque, identity-bound
reference. This page builds the counter from the
[default Live starter](../../examples/starter-live/src/main.ts).

## 1. Install

```sh
npm install nestvexa express-session
```

The umbrella includes `@nestvexa/live`, the browser client
(`@nestvexa/client`), the Alpine bridge (`@nestvexa/alpine`) and the Alpine CSP
build. No bundler or SPA toolchain is needed. A session middleware is required
because every Live request is bound to a server-side identity and a CSRF token.

## 2. Write a component

Decorators come from `nestvexa` (re-exported from `@nestvexa/live`). `@State()`
fields are public and read-only from the browser unless you mark them
`writable`, optionally with a validator. `@Computed()` values are derived on the
server. Only `@Action()` methods can be called.

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
@LiveComponent({ name: 'counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  name = '';
  @State() saved = '';
```

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
  @Computed() get doubled(): number {
    return this.count * 2;
  }
  @Action() increment(): void {
    this.count++;
  }
  @Action() save(): void {
    this.saved = this.name;
  }
```

The component template (`views/counter.hbs`) uses `nv:` directives. They are
plain attributes with a data-only grammar; no expression is ever evaluated in
the browser:

```hbs
<section aria-label='Counter'>
  <output id='count'>{{count}}</output>
  <output>{{doubled}}</output>
  <button
    type='button'
    nv:click='increment'
    nv:loading.attr='disabled'
  >Increment</button>
  <form nv:submit='save'>
    <label>Name <input name='name' nv:model='name' value='{{name}}' /></label>
    <button type='submit'>Save name</button>
  </form>
  <output id='saved'>{{saved}}</output>
</section>
```

`nv:model` is deferred by default: the value travels with the next action. Use
`nv:model.live`, `.blur` or `.change` (with `.debounce.300ms`, `.number`,
`.boolean`) for earlier synchronization. Every directive has a page in the
[directive reference](../reference/directives.md).

## 3. Register it with host policies

Live is enabled on the umbrella module together with three host-owned policies:
the exact `origin`, `resolveIdentity` (who is calling, and the session's CSRF
token) and `authorize` (which component operations this identity may run). The
policy is deny-by-default: `$mount`, `$sync` (writable model updates) and every
action must be allowed explicitly.

```ts
NestvexaModule.forRoot(
  { views: { root, layout: 'layout' }, live: { enabled: true } },
  {
    components: [Counter],
    useFactory: () => ({
      origin: 'http://127.0.0.1:3102',
      resolveIdentity(request: object) {
        const value = request as Partial<SessionRequest>;
        if (!value.session?.csrf || !value.sessionID)
          throw new UnauthorizedException();
        return {
          binding: `guest-session:${value.sessionID}`,
          csrfToken: value.session.csrf,
        };
      },
      authorize: (_identity, component, action) =>
        component === 'counter' &&
        ['$mount', '$sync', 'increment', 'save'].includes(action),
    }),
  },
);
```

This guest identity is a demonstration. Production identities bind the
authenticated user and tenant; see [hardening](../security/hardening.md).

## 4. Mount it from a controller

An ordinary Nest route authorizes the page, issues the session CSRF token and
mounts the component. `mount()` returns trusted `SafeHtml`, so the page template
prints it with normal escaped syntax (`{{widget}}`).

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
  @Render('home')
  async home(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Nestvexa default Live setup',
      widget: await this.live.mount(Counter, request),
    };
  }
```

Inject the runtime with `constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}`.
Put `{{nvScripts}}` once in the layout `<head>`; it emits one external module tag
that starts the Live client and Alpine (pass `nonce=cspNonce` for nonce-based CSP).
Finally, install the session middleware and call `configureNestvexa(app)` before
`listen()`:

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      maxAge: 900_000,
    },
  }),
);
await configureNestvexa(app);
```

## 5. Run and test

```sh
pnpm build
pnpm --filter @nestvexa/example-starter-live start   # http://127.0.0.1:3102
```

The real-browser flows are in [default-setup.spec.ts](../../tests/browser/default-setup.spec.ts)
and the server behavior in [umbrella-live.test.ts](../../tests/umbrella-live.test.ts).

## How a request is protected

Each action is a `POST` to a generated Nest route under `/_nestvexa/live`. The
runtime checks the origin, CSRF token, identity binding, snapshot ownership,
revision (a replay or stale tab gets `409`) and your `authorize` policy, then runs
your own guards, pipes, interceptors and filters. Read-only state cannot be
changed from the browser, and `@Locked()` is a read-only marker, **not**
authorization. Details: [Live protocol](../guides/live-protocol.md) and
[hook order](../guides/live-lifecycle.md).

## Next steps

- Alpine inside Live: wrap Alpine-owned markup in `nv:ignore` and use
  `$live.call/get/set` ([default setup](../guides/default-live-setup.md)).
- Child components, events, lazy loading: [nested components](../guides/nested-components.md).
- Redirects, flash, downloads, pagination: [effects](../guides/live-effects.md).
- URL and session state: [URL/session state](../guides/url-session-state.md).
- Validation with Zod or class-validator: [forms](../guides/forms.md).
- Other engines for components: [template engines](../guides/template-engines.md#live-components-on-any-engine).

> **Known gap:** Live state lives in the process-local `MemoryLiveStore`; there
> is no shared store, so several replicas need sticky sessions and a restart
> loses component state (requests fail closed). `@State` custom serializers,
> `@Action({ concurrency, idempotent })`, Alpine `$live` entanglement beyond
> `call/get/set` are not implemented. Live actions need JavaScript; for
> no-JavaScript submissions post an ordinary form to a controller
> ([forms guide](../guides/forms.md#4-the-same-form-without-javascript)). Nest testing helpers for components (a Livewire-style
> `test()` API) do not exist; tests drive real Nest apps over HTTP.
