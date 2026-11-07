# Coming from Livewire and Laravel

Nestvexa Live is inspired by Livewire's behavior, not its wire protocol or code.
If you know Livewire 3/4, most concepts have a direct counterpart, but the trust
model is stricter: state is stored on the server, the browser holds an opaque
identity-bound reference, and every operation needs explicit authorization.
Start with [Live components](../getting-started/live.md).

## Concept mapping

| Livewire / Laravel                                                                            | Nestvexa                                                                                                                                                                     | Notes                                                                                    |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `class Counter extends Component`                                                             | `@LiveComponent({ name, view })` class                                                                                                                                       | Resolved by Nest DI; must be listed in `components`                                      |
| `public $count`                                                                               | `@State() count = 0`                                                                                                                                                         | **Read-only from the browser** unless `@State({ writable: true, validate })`             |
| `#[Locked]`                                                                                   | `@Locked()`                                                                                                                                                                  | Same as read-only state; not authorization                                               |
| `#[Computed]`                                                                                 | `@Computed()` getter or async method                                                                                                                                         | Never writable, never an action ([computed values](../guides/computed-values.md))        |
| public methods / `wire:click="save"`                                                          | `@Action() save()` / `nv:click="save"`                                                                                                                                       | Only decorated methods are callable, and only if `authorize` allows them                 |
| `#[Renderless]`                                                                               | `@Action({ renderless: true })`                                                                                                                                              | [Renderless actions](../guides/renderless-actions.md)                                    |
| `wire:model`, `.live`, `.blur`, `.change`, `.debounce`                                        | `nv:model`, `.live`, `.blur`, `.change`, `.debounce.300ms`, `.number`, `.boolean`                                                                                            | Deferred by default, as in Livewire 3+                                                   |
| `wire:submit`, `wire:keydown.enter`                                                           | `nv:submit`, `nv:keydown.enter`                                                                                                                                              | Modifiers in the [directive reference](../reference/directives.md)                       |
| `wire:loading`, `wire:target`, `wire:dirty`                                                   | `nv:loading`, `nv:target`, `nv:dirty`                                                                                                                                        |                                                                                          |
| `wire:ignore`, `wire:replace`                                                                 | `nv:ignore`, `nv:ignore.self`, `nv:replace`, `nv:replace.self`                                                                                                               |                                                                                          |
| `wire:show`, `wire:text`, `wire:bind`, `wire:cloak`, `wire:ref`                               | `nv:show`, `nv:text`, `nv:bind`, `nv:cloak`, `nv:ref`                                                                                                                        | `nv:bind` only binds an allowlist of attributes                                          |
| `wire:poll`, `wire:init`, `wire:intersect`                                                    | [`nv:poll`](../reference/nv-poll.md), [`nv:init`](../reference/nv-init.md), [`nv:intersect`](../reference/nv-intersect.md)                                                   |                                                                                          |
| `wire:navigate`, `wire:current`, `wire:offline`                                               | [`nv:navigate`](../reference/nv-navigate.md), [`nv:current`](../reference/nv-current.md), [`nv:offline`](../reference/nv-offline.md)                                         |                                                                                          |
| `wire:confirm`, `wire:transition`, `wire:stream`, `wire:sort`                                 | [`nv:confirm`](../reference/nv-confirm.md), [`nv:transition`](../reference/nv-transition.md), [`nv:stream`](../reference/nv-stream.md), [`nv:sort`](../reference/nv-sort.md) |                                                                                          |
| optimistic UI with Alpine                                                                     | [`nv:optimistic`](../reference/nv-optimistic.md)                                                                                                                             | Projections are untrusted and roll back on failure                                       |
| `mount()`, `boot()`, `hydrate()`, `dehydrate()`, `updating`/`updated`, `rendering`/`rendered` | `mount`, `boot`, `hydrate`, `dehydrate`, `beforeUpdate`/`afterUpdate`, `beforeRender`/`afterRender`, plus `beforeAction`/`afterAction`, `onError`, `dispose`                 | [Hook order](../guides/live-lifecycle.md)                                                |
| `#[Url]`, session-persisted properties                                                        | `@Url({ key })`, `@Session({ ttl })` on a `@State` field                                                                                                                     | [URL/session state](../guides/url-session-state.md)                                      |
| `<livewire:child :prop="$x" />`, `#[Reactive]`, `#[Modelable]`                                | `{{nvChild 'alias' key prop=x}}` with `children: { alias: Child }`, `@Prop`, `@Reactive`, `@Modelable`                                                                       | Children are an explicit allowlist ([nested components](../guides/nested-components.md)) |
| `$this->dispatch()`, `#[On('event')]`                                                         | `dispatchLiveEvent(this, name, detail)`, `@OnEvent(name)`                                                                                                                    | Browser-routed between mounted components                                                |
| `#[Lazy]`, placeholders                                                                       | `@LiveComponent({ lazy: true \| 'visible', placeholder })`                                                                                                                   | Host must authorize `$sync`                                                              |
| `$this->redirect()`, `session()->flash()`                                                     | `redirectLive(this, '/path')`, `flashLive(this, message)` + `consumeLiveFlash(request)`                                                                                      | [Effects](../guides/live-effects.md)                                                     |
| `return Storage::download(...)`                                                               | `downloadLive(this, {...})`                                                                                                                                                  | Short-lived, identity-bound download tokens                                              |
| `WithPagination`                                                                              | `paginate()` with `@Url({ key: 'page' })`                                                                                                                                    |                                                                                          |
| `#[Validate]`, `$this->validate()`, form objects                                              | `@nestvexa/forms`: `validateLive`, `validateField` with Zod, class-validator or custom adapters                                                                              | [Forms](../guides/forms.md)                                                              |
| `WithFileUploads`, temporary uploads                                                          | `@nestvexa/uploads`: streamed temporary upload, token, `finalize()`                                                                                                          | [Uploads](../guides/uploads.md)                                                          |
| Property synthesizers                                                                         | `StateSynthesizer`, `DateSynthesizer`, `BigIntSynthesizer`                                                                                                                   |                                                                                          |
| `$wire` in Alpine                                                                             | `$live.call()`, `$live.get()`, `$live.set()` inside `nv:ignore`                                                                                                              | [Default setup](../guides/default-live-setup.md)                                         |
| Broadcasting / Echo listeners                                                                 | `@nestvexa/realtime` channels (`@RealtimeChannels`) over SSE/WebSocket/polling                                                                                               | [Realtime](../guides/realtime.md)                                                        |
| Blade templates                                                                               | Handlebars by default; EJS, Pug, Nunjucks or a custom adapter                                                                                                                | [Template engines](../guides/template-engines.md)                                        |

## Differences that matter

- **Server-side state.** Livewire sends a checksummed snapshot of public
  properties to the browser. Nestvexa keeps state in a server-side,
  identity-bound store with revision locks; the browser snapshot is only a
  reference. A replayed or stale request returns `409`.
- **Deny by default.** Public Livewire methods are callable unless you
  authorize inside them. Nestvexa's host `authorize(identity, component, action)`
  must allow `$mount`, `$sync` and each action name, and your Nest guards, pipes,
  interceptors and filters run on the generated routes as well.
- **Writes are opt-in.** A Livewire public property can be set from the browser
  unless locked. A Nestvexa field is writable only when declared
  `writable: true`, and a validator is strongly recommended.
- **No expressions in directives.** `nv:click="save"` names an action; arguments
  and JavaScript expressions are rejected. Use `@ActionInput` with a DTO pipe for
  action arguments, and Alpine (inside `nv:ignore`) for client-only logic.
- **Identity and CSRF are host-owned.** There is no built-in auth guard. You map
  your session or user to `{ binding, csrfToken }` in `resolveIdentity`.
- **Nest, not Laravel, owns the request.** Middleware, exception handling and
  DI are Nest's; there is no service container, facade or Eloquent integration.

## Porting a component

1. Create the class with `@LiveComponent`, convert public properties to
   `@State()` and mark user-editable ones `writable` with a validator.
2. Convert public methods called from the view to `@Action()` methods; inject
   services through the constructor with `@Inject(...)`.
3. Rewrite the Blade view in Handlebars, replacing `wire:` with `nv:`.
4. Register the component, add its actions to `authorize`, and mount it from a
   controller with `await live.mount(Component, request)`.
5. Port Livewire tests to HTTP/browser tests against a real Nest app (see
   [testing](../testing/browser-fixtures.md)).

> **Known gap:** There is no `Livewire::test()`-style component testing API,
> no Volt/single-file components, no Livewire 4 `@island` partial-render blocks,
> no full `$wire` entanglement, and no full-page components with
> `#[Layout]`, `#[Isolate]` or `#[Transition]` (mount components from a host
> route, every component is already its own request, and use `nv:transition`;
> see [ADR 0035](../adr/0035-live-layout-isolation-and-transitions.md)).
> Server-pushed `@OnEvent` domain events (`LiveEvents`), `@Action({ concurrency,
idempotent })` and the shared `RedisLiveStore` for several replicas are
> available.
