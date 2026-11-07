# @nestvexa/live

Each component operation creates a fresh explicitly registered component using
the actual Nest request context; request-scoped dependencies remain shared within
that HTTP request. See [instance isolation](../../docs/guides/component-instance-scope.md).

Ordinary guarded Nest routes can serve [authorized text streams](../../docs/guides/text-streams.md)
using `LiveRuntime.authorizeStream`, `parseTextStreamRequest` and
`createTextStreamResponse`. Streams are read-only, bounded, checked around each
awaited chunk, and cancelled before the HTTP adapter closes. They do not bypass
host resource policies or claim action-guard execution for a read.

`@Url` and `@Session` pair with explicit public `@State` fields. URL values use
typed primitive validation; session values use the host-owned session object,
authoritative identity binding, component/field namespace and TTL. See
[URL/session state](../../docs/guides/url-session-state.md). Neither decorator
supplies authentication or a production session store. The [activity example](../../examples/starter-live/src/activity-panel.ts)
exercises URL history, independent sessions and protected background actions.

`ComputedOptions` now supports synchronous getters and explicit `async: true`
zero-argument methods, with instance/stage-local memoization, state dependencies,
TTL and async evaluation deadlines. Returned JSON is detached; computed names
remain outside writable state and action routes. See
[computed values](../../docs/guides/computed-values.md) for defaults, invalidation,
resource bounds, failure handling and alpha migration changes.

Computed methods reject Nest route/parameter/policy decorators such as method-level
`@UseGuards`: they are not route invocations, so that metadata would not execute.
Authorize sensitive reads in host routes and services. Normal Live action guards
and component policies retain their existing execution pipeline.

Phase 4 begins with awaited `boot`, `beforeUpdate` and `afterUpdate` hooks and
exported `LiveLifecycleHooks`, `LiveUpdateContext` and `ReadonlyLiveValue` types.
All input validation precedes execution; update context is detached/frozen. See
[ordering, failure boundaries and reserved-name migration](../../docs/guides/live-update-hooks.md).
Awaited `beforeRender`, `afterRender`, `onError` and request `dispose` hooks are now implemented; see [the lifecycle guide](../../docs/guides/live-lifecycle.md). Server nesting and whole Phase 4 acceptance remain open.

Experimental Nest-native Live components. This first slice has explicit component/action registration, JSON state, computed getters, opaque server-side snapshots, host identity/CSRF/origin/authorization checks and generated Nest controller routes. It is not the full Live feature set.

## Install and setup

Not published. Install local tarballs after `pnpm build && pnpm test:pack`. Future registry syntax is `npm install @nestvexa/live` / `pnpm add @nestvexa/live` / `yarn add @nestvexa/live`, subject to owner publication. Peers: Nest12 common/core, reflect-metadata0.2 and RxJS7. Node22.13/24 targeted; actual matrix is recorded separately.

```ts
@LiveComponent({ name: 'counter', view: 'counter' })
export class Counter {
  @State() count = 0;
  @Computed() get doubled() {
    return this.count * 2;
  }
  @Action() increment() {
    this.count++;
  }
}
```

Import `LiveModule.register({ components: [Counter], imports: [HostServicesModule], renderer, origin, resolveIdentity, authorize })`. The renderer implements the public views adapter. Host service dependencies must be exported by imported Nest modules. The host identity resolver returns `{binding, csrfToken}` from verified session context; it must not trust body claims. Binding must include the host session, user and tenant as applicable. Authorize receives each component/action, `$mount` and the internal model synchronization action `$sync`; permit each explicitly where intended. Mount from a guarded host route using `await liveRuntime.mount(Counter, request)` and render its `SafeHtml` value.

The manual runnable bootstrap is in [live-counter](../../examples/live-counter/README.md). The default `nestvexa` module also supports an explicit second registration argument sharing its HBS renderer and browser boot, as shown in [starter-live](../../examples/starter-live/README.md).

`LiveModule.registerAsync({ components, endpoint?, basePath?, imports?, inject?, useFactory })` resolves renderer and host security policies through Nest DI. Its factory returns `renderer`, `origin`, `resolveIdentity`, `authorize`, optional `store` and optional `maxRequestsPerMinute`. Component types and paths are static because Nest needs them before factory resolution. Configuration factories must be singleton-scoped, validate output at startup, and cannot introduce hidden components or routes. Components still resolve request-scoped dependencies per request. The module snapshots static arrays to prevent later registration mutation. See [async tests](../../tests/live-async.test.ts).

Disjoint registrations may live in separate Nest modules. An application-local DI registry rejects duplicate component types, names and action routes during construction, and delegates `LiveRuntime.mount` to the correct registration's policy, renderer and state store. It shares the request context ID across mounted components without bypassing each module's service exports. Closed runtimes reject further mounts.

The host owns the supplied renderer lifecycle: initialize it before requests and dispose it during shutdown, using a Nest lifecycle provider as the counter example does. Live does not automatically initialize/dispose a renderer that may be shared with MVC or another host integration.

## Contracts and limits

Nested components, events, lazy components and redirects: `@LiveComponent({ children: { alias: Child }, lazy?, placeholder? })`, the `nvChild alias key props…` template helper, `@Prop()`, `@Reactive()`, `@Modelable()`, `@OnEvent(name)` (on an `@Action`), `dispatchLiveEvent(this, name, payload, { to?, self? })` and `redirectLive(this, path)`. See the [nested components guide](../../docs/guides/nested-components.md).

Downloads, flash messages, pagination and typed state: `downloadLive(this, { filename, contentType?, body })`, `flashLive(this, message)` with `consumeLiveFlash(request)`, `paginate({ page, perPage, total })`, and `@State({ synthesizer: DateSynthesizer | BigIntSynthesizer })`. See the [effects guide](../../docs/guides/live-effects.md).

Realtime: `@RealtimeChannels()` marks a method returning channel names; with the host `realtime` signer option (for example `RealtimeService` from `@nestvexa/realtime`) components refresh when those channels publish. See the [realtime guide](../../docs/guides/realtime.md).

State stores: the `store` option accepts any `LiveStateStore` (`create`, `peek`, `transaction`, `revoke`, `delete`, `close`; sync or async). `MemoryLiveStore` is the default: process-local, bounded (`maxEntries` 1000, `ttlMs` 15 min) and lost on restart, so it fits development and single-process deployments only. Several replicas need a shared store such as `RedisLiveStore` from [`@nestvexa/realtime-redis`](../realtime-redis/README.md). Every store must keep the documented identity-binding, revision compare-and-set, single-transaction, TTL and no-resurrection semantics; [`tests/live-store-contract.test.ts`](../../tests/live-store-contract.test.ts) is the shared contract suite, and `isLiveStateStore`, `liveStateUnavailable`, `liveBindingHash`, `freezeStateSnapshot` and `assertLiveComponentName` are exported for implementers. On shutdown the runtime calls `store.close()`. See [ADR 0032](../../docs/adr/0032-distributed-state-and-redis.md).

Tracing: the optional `instrumentation` policy receives `nestvexa.live.mount`, `nestvexa.live.admit` (request admission, with the closed error code of a rejection), `nestvexa.live.hydrate`, `nestvexa.live.hook`, `nestvexa.live.action` and `nestvexa.live.render` spans with names, revisions and sizes only (see `@nestvexa/observability`). The optional development-only `inspector` policy (for example `DevtoolsInspector`) receives the registered component catalog and each top-level render's public state, cause and sizes; `LiveRuntime.describeComponents()` returns the catalog.

Kernel policies (structural, no `@nestvexa/core` dependency, [ADR 0030](../../docs/adr/0030-live-kernel-boundary.md)): with `policies` (any object shaped like `SecurityPolicyRegistry` from `@nestvexa/core`), Live registers its `origin`, `csrf`, `action-authorization` and `snapshot` policies once under `policyOwner` (default `live`; a second registration of the owner fails startup) and asks the registry for every origin, CSRF and authorization decision (mount, child mount, actions, `$sync`, text streams), so the registry is the single source of truth. `liveSecurityPolicies(options)` is the one implementation (exact origin, constant-time `x-nestvexa-csrf` comparison, host `authorize` where only a literal `true` admits); without `policies` Live enforces the same objects directly. The snapshot policy reports the store's `ttlMs` (`MemoryLiveStore` and `RedisLiveStore` declare it). `requestContext` (for example `RequestContextFactory`) adds `nestvexa.request_id` to admission, mount and action spans. The `nestvexa` umbrella passes both automatically.

Rate limit: `maxRequestsPerMinute` (default 60) per identity binding counts mounts, actions, `$sync` and stream authorizations; a rejected request gets `429 { statusCode, code: 'RATE_LIMIT' }` with `Retry-After` (seconds until the identity's window resets) before any state is read or component code runs.

`@State({writable:true})` explicitly allows top-level JSON updates; default state is locked against client writes. `@Locked()` is an equivalent readable state declaration. `@Computed()` supports synchronous getters; `@Computed({async:true})` supports awaited zero-argument methods. `@Action({id?, renderless?})` exposes only registered methods; `renderless: true` acknowledges state without rendering when the client negotiates `renderless-v1` (see the [renderless guide](../../docs/guides/renderless-actions.md)). A single argument may use `@ActionInput(...pipes)`; normal Nest parameter pipes perform transformation and validation. No arbitrary service or class selection is accepted.

Writable state can supply a pure `validate(value)` callback returning `boolean` or `Promise<boolean>`:

```ts
@State({
  writable: true,
  validate: (value) => typeof value === 'string' && value.length <= 80,
})
name = '';
```

The callback receives detached, frozen JSON and must return exactly `true` to accept it. It runs before component hooks, action effects and the store transaction; it must not perform side effects. Locked, type-mismatched or rejected updates return422 without consuming the current snapshot, allowing a corrected request at the same revision. The transaction rechecks the revision after asynchronous validation, so a competing update can still produce409. Validator exceptions are application errors and are not converted into field validation messages. This primitive is not the planned DTO/Zod forms subsystem.

Class/method guards, pipes, interceptors and filters execute on generated Nest routes using copied metadata. The action instance resolves through public `ModuleRef` with the actual request context and request scope. ExecutionContext identifies the generated controller, not the component class by identity; custom metadata is copied. Interceptors observe the Live response envelope. Global host middleware and policies remain host-owned. See actual integration tests for validated behavior; this is not a blanket claim covering every Nest extension.

Each registered component also has `POST <endpoint>/<component>/_sync` for model synchronization. The reserved path cannot name a public action. The host authorizes it as `$sync`, with the normal origin/CSRF/identity/ownership/rate/payload/revision checks. It uses component/global Nest route policies, interceptors and filters; there is no selected action method or action input, so action-method guards, pipes, interceptors and filters are not copied onto it. Policies required for all writable state must therefore live at component/global scope or in `authorize`. Synchronization accepts absent/null `input` only and does not call any action.

Hooks include boot/mount/hydrate, field updates, action hooks, dehydrate, beforeRender/afterRender, onError and request disposal. See [exact ordering and failure rules](../../docs/guides/live-lifecycle.md), including nested parent/child order. Computed caches clear around hooks and before rendering. Only decorated public state is stored; typed fields need a synthesizer.

## Protocol, action options and typed state

The exact wire contract, every error code and every limit are in the [Live protocol reference](../../docs/reference/live-protocol.md). Highlights:

- `LIVE_REQUEST_SCHEMA`, `LIVE_RESPONSE_SCHEMA`, `LIVE_ERROR_SCHEMA` (JSON Schema 2020-12), `LIVE_ERROR_CODES` (status and recovery per code), `LIVE_PROTOCOL`, `LIVE_LIMITS`, `LIVE_CAPABILITIES` and `parseLiveCapabilities` are exported. `x-nestvexa-capabilities` is a token list; unknown well-formed tokens are ignored and malformed headers fail with `400 INVALID_CAPABILITIES`.
- `@Action({ idempotent: true })` replays an identical committed retry (`replayed: true`) and rejects a reused request ID with another payload (`422 IDEMPOTENCY_CONFLICT`); non-idempotent duplicates fail with `409 STALE_REVISION`, never running twice. `@Action({ concurrency: 'identity' })` allows one execution per identity across tabs (`409 ACTION_BUSY`). Both are process-local with the default store and shared across replicas when the store implements `LiveActionCoordination` (for example `RedisLiveStore`; [ADR 0031](../../docs/adr/0031-live-protocol-evolution-and-action-replay.md), [protocol reference](../../docs/reference/live-protocol.md#action-options)).
- `@LiveComponent({ timeoutMs })` bounds hooks and actions (`504 HOOK_TIMEOUT`/`ACTION_TIMEOUT`); `liveAbortSignal(this)` aborts on the deadline or at shutdown. Shutdown drains in-flight requests for up to 10 s.
- `@State({ synthesizer })` (alias `serializer`) with `DateSynthesizer`, `BigIntSynthesizer`, `enumSynthesizer`, `nullableSynthesizer`, `setSynthesizer`, `mapSynthesizer` or your own `defineSynthesizer`; a synthesizer decides which client JSON a writable field accepts. `@State({ default })` fills uninitialized fields per instance.
- `@State({ writable: ['city', 'geo.lat'] })` allowlists nested paths of an object field: the client sends the whole object and any difference outside those leaves (or an added/removed key) fails with `422 STATE_LOCKED` before component code runs; `describeLiveState()` reports `writablePaths` ([nested models](../../docs/guides/nested-models.md)).
- Action and `$sync` replies carry `x-nestvexa-protocol` and `x-nestvexa-capabilities`; the wrapper lists idempotent actions in `data-nv-idempotent`, the only actions the browser retries ([client transport](../../docs/guides/client-transport.md)).
- Startup rejects host controller routes that overlap generated Live routes, with the controller and method in the message.
- Optional decorators: `@Renderless()` on an `@Action` equals `@Action({ renderless: true })`; `@Validate(validator)` on a writable `@State` accepts a function, a Standard Schema v1 (Zod 3.24+, Valibot, ArkType) or a `safeParse` schema and rejects client writes with `422 STATE_INVALID` before any hook runs; `@ActionInput(schemaPipe(schema))` validates action input and passes the schema output (`400 { message, issues }`, input never echoed); `@Title()` on a getter or method returns plain text that a rendered action response carries as `title` and the browser applies to `document.title` for top-level components. `@Transition` and `@Layout` are intentionally not provided: transitions are the `nv:transition` directive, and layouts belong to the host route that renders the page around mounted components.
- `assetVersion` makes a stale page reload (`409 ASSET_VERSION_MISMATCH`); `LiveEvents` publishes server-pushed `@OnEvent` domain events through a structural publisher such as `RealtimeService` ([reference](../../docs/reference/live-protocol.md#server-pushed-domain-events)).

Live depends on `@nestvexa/views`, not on `@nestvexa/core`; see [ADR 0030](../../docs/adr/0030-live-kernel-boundary.md).

Read [protocol](../../docs/guides/live-protocol.md) for the64KiB/depth/node limits, token binding, 15-minute fixed expiry, capacity1000, revision conflicts and failure invalidation. Default rate limit is 60 requests/minute per binding. Configure host body parser limits before parsing. In-memory state is single-process; no distributed or exactly-once guarantee. Failed callbacks invalidate state because external side effects may already have happened. The browser retries only actions declared idempotent, with the same request ID. The host must revoke the binding on logout. Host policies and handlers need their own external-operation timeouts.

`endpoint` defaults to `/_nestvexa/live`. Set `basePath` to a host global prefix such as `/app`; generated route paths stay relative to Nest's prefix while mount URLs include it. Express/Fastify prefix flows have integration tests; host routing/versioning variants still require broader acceptance. Responses use `Cache-Control: no-store`; host mount routes must also set that header. Initial/update HTML is limited to1MiB. State type checks preserve top-level kinds; use pure state validators for domain constraints and action DTOs for action input validation. The experimental protocol may require reload/migration between alpha versions.

Run `pnpm test` and `pnpm test:e2e` at repository root. See [security policy](../../SECURITY.md), [changelog](../../CHANGELOG.md) and [status](../../docs/implementation/STATUS.md). Maintainer and hosted URLs await owner input.
