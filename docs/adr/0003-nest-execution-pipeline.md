# ADR 0003: Preserve the host Nest pipeline

Status: accepted. Amended 2026-11-07: Live and server actions now run through generated Nest controllers (see the amendment below).

Implementation update, 2026-10-26: the initial Live slice now generates actual Nest controllers with public decorators and copied class/method/parameter metadata. Components resolve through each registration's `ModuleRef`, with an application-local request-context registry. [Live pipeline tests](../../tests/live.test.ts) and [registration tests](../../tests/live-registration.test.ts) exercise Express/Fastify guards, pipes, interceptors, filters, scopes, ownership, collisions and shutdown races. Custom code observes the generated controller in `ExecutionContext`; complete parity across all Nest integrations remains an open release requirement.

MVC uses normal `@Render`, never a custom method invoker. Express gets a native engine callback. Fastify gets a public `reply.view` decorator consumed by Nest's own HTTP adapter. Configuration rejects a pre-existing Fastify view owner. This retains Nest's actual controller execution rather than reading guard metadata and pretending it executed.

Rejected: replacing every `@Render` with a custom interceptor, or manually calling guards with new instances. These approaches risk ordering, scopes and filter behavior. The public bridge costs two platform integration tests and leaves platform-specific semantics visible.

[Integration tests](../../tests/integration.test.ts) exercise both platforms, request scopes, method guards, pipes, interceptors and prefixes. They do not prove future non-controller Live parity. Generated controller methods or explicit Nest wrappers must be evaluated before exposing Live actions; a metadata-only dispatcher is not accepted.

## Trade-offs and cost

- Generated controllers keep Nest's real ordering of guards, pipes,
  interceptors, filters and request scopes. The cost is one generated route per
  Live action, per `_sync` endpoint and per server-action method, plus startup
  checks that reject host routes overlapping them.
- Platform semantics stay visible. Express and Fastify differ in body parsing
  and error shapes for malformed input, so every pipeline claim needs a test on
  both platforms.
- Framework envelopes sit inside the pipeline, not around it. Global
  interceptors see the action envelope (`{ ok, data }`), while class and method
  interceptors see the raw return value. Global exception filters do not see
  action errors unless the host opts into `errorEnvelope: 'host'`.

## Failure modes

- A guard that reads metadata from a decorator Nestvexa did not copy. The
  generated controller copies class, method and parameter metadata, and custom
  code sees the generated controller in `ExecutionContext`. Tests cover the
  public decorators; private metadata keys of third-party libraries are not
  covered.
- Live `_sync` has no selected action method, so action-method guards, pipes,
  interceptors and filters do not run on it. Policies that must apply to all
  writable state belong at component or global scope, or in `authorize`
  ([Live README](../../packages/live/README.md)).
- A host route collides with a generated route. Startup fails and names the
  controller and method.
- Nest transports other than HTTP (GraphQL, microservices, WebSocket gateways)
  are not wired to Live or actions. Running them side by side is untested.

## Amendment (2026-11-07): Live and server actions use the pipeline

The open point in the status line is resolved for HTTP. Live components and
server actions both run through generated Nest controllers. Neither uses a
metadata-only dispatcher.

- Live: [pipeline tests](../../tests/live.test.ts),
  [registration tests](../../tests/live-registration.test.ts) and
  [instance-scope tests](../../tests/live-instance-scope.test.ts) cover Express
  and Fastify guards, pipes, interceptors, filters, request scopes, ownership
  and route collisions.
- Server actions (`@nestvexa/actions`, [ADR 0019](0019-universal-server-actions.md)):
  Nest global guards run first, then admission as the first class guard, then
  group and method guards, interceptors, pipes and the input schema.
  `tests/actions-http.test.ts` covers this order, CSRF rejection before guards
  and denial at each guard level on Express and Fastify.
- Inertia pages are ordinary controller methods. `@nestvexa/inertia` adds
  `InertiaInterceptor` (global or per controller) and a render service, and
  the controller still runs its own guards and pipes
  ([ADR 0018](0018-inertia-server-adapter.md)).

Still open: parity with non-HTTP Nest transports, and third-party guards that
depend on private metadata.
