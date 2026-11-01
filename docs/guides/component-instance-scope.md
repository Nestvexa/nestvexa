# Component instances and Nest dependency scopes

Each authorized Live mount or action creates a fresh component object. Mounting the same registered component type twice in one HTTP request creates two independent objects, public state records, component IDs, snapshots, computed caches, and cleanup operations. Subsequent actions create another object and restore only that component's allowlisted public state.

This avoids a subtle Nest DI behavior: calling `ModuleRef.resolve(Type, contextId)` repeatedly with the same type and context reuses the resolved instance. That is useful for request services, but mutable component fields must not be shared between sibling component mounts.

Nestvexa uses the public `ModuleRef.create(registeredType, requestContext)` API for component construction. The owning Live registration selects the type; no browser-supplied class name, template path, import path, or constructor is resolved. The runtime keeps the actual request's context ID and registers its `REQUEST` provider before creating the component. The installed Nest 12 public API supports the explicit context argument. See Nest's [module reference guide](https://docs.nestjs.com/fundamentals/module-ref) and [injection scopes guide](https://docs.nestjs.com/fundamentals/injection-scopes).

## Service behavior

- A request-scoped service remains shared by components, guards, and a request-scoped host controller using the same HTTP request context. A different HTTP request receives a different instance.
- A transient dependency injected directly into a component is fresh for each component object. Its request-scoped dependencies still refer to the request's shared instances.
- Normal singleton business services retain their ordinary Nest lifetime. Mutable user state belongs in the component's declared state or an explicitly isolated host store.
- Injected `REQUEST` is the actual adapter request used by the host/controller/guards. A fresh component does not create a synthetic HTTP request or replace the existing request context.
- Dependencies remain subject to the owning module's imports and exports. A service in an unexported sibling module does not become visible through component construction.

`@LiveComponent` definitions remain explicitly registered with `LiveModule.register` or `registerAsync`. Their runtime objects are deliberately fresh even when a class's other metadata would suggest reuse. Do not inject a mutable component into another component as a shared state service. Share an ordinary Nest provider and pass explicit public values instead.

## Actions, identity, and cleanup

Action requests still enter their generated normal Nest handlers. Origin, CSRF, ownership, host authorization, guards, pipes, interceptors, filters, and revision checks retain their existing behavior. This construction change does not manually execute guards. A request rejected before component construction creates no component object.

Separate component snapshots remain independent even when mounted simultaneously from the same host route. A snapshot bound to another authoritative user/session/tenant is rejected before creating its component. The browser cannot select another constructor by changing the component name in its state.

Every successfully constructed request operation runs its awaited lifecycle and disposal contract. A constructor that throws never produces a usable component instance: no lifecycle/dispose hook can safely run on that incomplete object. Constructors should avoid external side effects and release resources they allocate before throwing. Prefer resource acquisition in awaited hooks and release it in `dispose`; an uncertain action failure still revokes its snapshot.

No component objects are retained in a global user-state array. Request DI resources follow Nest's context lifetime; component computed bookkeeping uses weak references. The bounded Live state store contains detached public JSON, rather than injected service objects or component instances.

## Verification and compatibility

[live-instance-scope.test.ts](../../tests/live-instance-scope.test.ts) boots actual Express and Fastify Nest applications. It checks simultaneous and sequential same-type mounts, fresh component and transient instances, shared request services and request identity, independent action state, unchanged class/method guard behavior, cookie-selected fixture identity isolation, constructor failures, explicit registration, and module visibility. Cookies in that fixture select fixed test identities; they are not a production authentication implementation.

Run:

```sh
pnpm build
pnpm exec vitest run tests/live-instance-scope.test.ts tests/live-registration.test.ts
```

The existing [registration tests](../../tests/live-registration.test.ts) also verify ownership across separate Live registrations and shared imported request services. Future Nest versions must pass this contract before being listed as supported. This instance-isolation change is a prerequisite for server nesting; it does not by itself implement keyed server children, reactive parent/child props, or modelable bindings. Those remain tracked in the [feature ledger](../implementation/feature-ledger.md).
