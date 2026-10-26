# @nestvexa/live

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

Import `LiveModule.register({ components: [Counter], imports: [HostServicesModule], renderer, origin, resolveIdentity, authorize })`. The renderer implements the public views adapter. Host service dependencies must be exported by imported Nest modules. The host identity resolver returns `{binding, csrfToken}` from verified session context; it must not trust body claims. Binding must include the host session, user and tenant as applicable. Authorize receives each component/action and `$mount`. Mount from a guarded host route using `await liveRuntime.mount(Counter, request)` and render its `SafeHtml` value.

The complete runnable bootstrap is in [live-counter](../../examples/live-counter/README.md). The default `nestvexa` module still configures MVC separately and does not silently enable Live.

Disjoint registrations may live in separate Nest modules. An application-local DI registry rejects duplicate component types, names and action routes during construction, and delegates `LiveRuntime.mount` to the correct registration's policy, renderer and state store. It shares the request context ID across mounted components without bypassing each module's service exports. Closed runtimes reject further mounts.

The host owns the supplied renderer lifecycle: initialize it before requests and dispose it during shutdown, using a Nest lifecycle provider as the counter example does. Live does not automatically initialize/dispose a renderer that may be shared with MVC or another host integration.

## Contracts and limits

`@State({writable:true})` explicitly allows top-level JSON updates; default state is locked against client writes. `@Locked()` is an equivalent readable state declaration. `@Computed()` supports synchronous getters. `@Action({id?})` exposes only registered methods. A single argument may use `@ActionInput(...pipes)`; normal Nest parameter pipes perform transformation and validation. No arbitrary service or class selection is accepted.

Class/method guards, pipes, interceptors and filters execute on generated Nest routes using copied metadata. The action instance resolves through public `ModuleRef` with the actual request context and request scope. ExecutionContext identifies the generated controller, not the component class by identity; custom metadata is copied. Interceptors observe the Live response envelope. Global host middleware and policies remain host-owned. See actual integration tests for validated behavior; this is not a blanket claim covering every Nest extension.

Hooks in this slice: initial `mount → dehydrate → render`; update `hydrate → apply writable updates → beforeAction → action → afterAction → dehydrate → render`. These async hooks receive no arguments. Only decorated public state is stored. Dates, BigInt, classes, URL/session decorators, nesting, async computed methods and custom serializers are not supported yet.

Read [protocol](../../docs/guides/live-protocol.md) for the64KiB/depth/node limits, token binding, 15-minute fixed expiry, capacity1000, revision conflicts and failure invalidation. Default rate limit is60 requests/minute per binding. Configure host body parser limits before parsing. In-memory state is single-process; no distributed or exactly-once guarantee. Failed callbacks invalidate state because external side effects may already have happened. The browser never retries automatically. The host must revoke the binding on logout. Host policies and handlers need their own external-operation timeouts.

`endpoint` defaults to `/_nestvexa/live`. Set `basePath` to a host global prefix such as `/app`; generated route paths stay relative to Nest's prefix while mount URLs include it. Express/Fastify prefix flows have integration tests; host routing/versioning variants still require broader acceptance. Responses use `Cache-Control: no-store`; host mount routes must also set that header. Initial/update HTML is limited to1MiB. State type checks preserve top-level kinds; use action DTOs for deep/domain validation. The experimental protocol may require reload/migration between alpha versions.

Run `pnpm test` and `pnpm test:e2e` at repository root. See [security policy](../../SECURITY.md), [changelog](../../CHANGELOG.md) and [status](../../docs/implementation/STATUS.md). Maintainer and hosted URLs await owner input.
