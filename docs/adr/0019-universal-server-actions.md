# 0019 — Universal server actions and generated typed clients

Status: accepted for the experimental alpha implementation of Phase 12 tasks
12.3 and 12.4 (server registry and typed client generation). Framework hooks,
streaming results, job tickets and shared (Redis) stores remain open.

## Context and decision

Browser code outside Live components (HBS page scripts, islands, later
React/Vue/Svelte pages) needs to call Nest business logic with types, without
handwritten fetch strings and without turning services into an RPC surface.
Create `@nestvexa/actions`, independent of `@nestvexa/live` (neither imports the
other; `scripts/boundaries.mjs` enforces it).

Exposure is explicit at three levels: `@ActionGroup(id)` on a class,
`@ServerAction({ id, version? })` on a method, and listing the class in
`ActionsModule.register({ groups })`. `@Injectable`, visibility and method names
never expose anything. Group/action ids are kebab-case literals; versions are
explicit integers in the route (`/cart/add-item/v2`). Startup rejects duplicate
ids/versions, colliding client names, duplicate registrations and cross-module
route collisions through an application-scoped registry provider.

For Nest pipeline parity the module generates one real Nest controller per
group, the same strategy as Live: the group's class and method metadata
(guards, pipes, interceptors, filters, custom metadata, parameter decorators and
`design:paramtypes`) are copied onto a generated handler that delegates to the
DI-resolved group instance. Nest's router therefore runs global, class and
method enhancers, resolves request-scoped providers with the real context id,
and applies parameter pipes. `@ActionInput(...pipes)` is literally
`@Body('input', ...pipes)`, so `ValidationPipe` DTOs work unchanged.

Three internal enhancers bracket application code:

1. An admission guard prepended to class guards: POST, exact Origin,
   `application/json`, declared size, host `resolveIdentity`, constant-time CSRF
   comparison, rate limit hook, JSON shape/depth/node bounds, prototype-pollution
   keys, idempotency key format and host `authorize`.
2. An envelope interceptor prepended to class interceptors: deadline and
   `AbortSignal` (timeout, disconnect, shutdown), idempotent replay/conflict,
   serial dispatch per tenant+subject+group, and JSON-safe output normalization
   into `{ protocol, ok, requestId, data, redirect?, notifications? }`.
3. A catch-all filter prepended to class filters, which Nest evaluates last, so
   application method/class filters keep precedence. It produces stable codes
   (`VALIDATION`, `FORBIDDEN`, `UNAUTHENTICATED`, `NOT_FOUND`, `CONFLICT`,
   `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `TIMEOUT`, `INTERNAL`) and redacts
   5xx/non-HTTP messages unless `exposeErrorDetails` is enabled.

Type generation uses the TypeScript compiler API, not source patterns:
decorators are resolved through import aliases to this package's declarations,
ids/versions must be literals, and parameter/return types come from the checker.
Types are emitted structurally with JSON semantics (`Date` → `string`,
`ActionResult<T>` → `T`, `void` → `null`, `T | undefined` → optional), named
interfaces/aliases/enums become deterministic declarations, and non-serializable
types are diagnostics. The output is a tiny manifest module plus `.d.ts`; the
runtime client (`@nestvexa/actions/client`) is browser-safe and binds it.

## Alternatives and tradeoffs

- Reject a single dispatcher route (`/:group/:action`) that invokes methods
  manually: it would bypass or re-implement Nest guard/pipe/interceptor/filter
  semantics and request scoping. Generated routes keep Nest authoritative.
- Reject exposing methods by scanning providers or naming conventions: implicit
  exposure is the central RPC risk. Explicit registration costs one line.
- Reject runtime type extraction from schemas only: many Nest apps use DTO
  classes and pipes. Optional `input`/`output` schemas (structurally
  Zod-compatible, no dependency) add independent runtime checks where wanted.
- Reject emitting `import type` from server sources in generated files: the
  client must compile in packed consumers and browser bundles without server
  source paths. Structural emission costs fidelity for generic named types,
  which are inlined.
- Reject wrapping every action in a transaction: arbitrary work has no safe
  generic rollback. Services own transactions; actions get an `AbortSignal`.
- Tradeoff: global interceptors see the envelope and global filters do not see
  action errors (unless `errorEnvelope: 'host'`). Placing the envelope at class
  level keeps application class/method enhancers on raw values; `onError`
  provides telemetry.

## Failure modes, cost and compatibility

A timed-out call returns `TIMEOUT` while the handler may continue; the serial
lock and idempotency record stay held until it settles, so a retry with the same
key replays or conflicts instead of running twice. Services that ignore the
signal keep consuming capacity. Successful idempotent results are replayed for
the TTL; failures release the key. Memory stores, limiter and locks are
process-local; horizontally scaled hosts need shared implementations of the
documented `ActionIdempotencyStore` and rate-limit hook contracts.

Per-request cost is one extra guard, interceptor and JSON traversal (bounded by
depth/node limits) plus a canonical-JSON SHA-256 for idempotent calls. The wire
protocol is versioned (`nestvexa-actions/1`); adding envelope fields is
additive, and changing ids or versions is a breaking change for generated
clients. Codegen runs at build time and needs `typescript` (optional peer).

## Implementation and evidence

- [Module and route generation](../../packages/actions/src/module.ts),
  [admission/runtime](../../packages/actions/src/runtime.ts),
  [enhancers](../../packages/actions/src/enhancers.ts),
  [decorators](../../packages/actions/src/metadata.ts),
  [client](../../packages/actions/src/client/index.ts) and
  [generator](../../packages/actions/src/codegen/index.ts).
- [Express/Fastify pipeline and negative corpus](../../tests/actions-http.test.ts),
  [startup validation](../../tests/actions-metadata.test.ts),
  [primitives](../../tests/actions-runtime.test.ts),
  [client](../../tests/actions-client.test.ts),
  [codegen and compile-time fixtures](../../tests/actions-codegen.test.ts),
  [browser acceptance](../../tests/browser/actions.spec.ts) and the packed
  consumer in [tests/pack-consumers](../../tests/pack-consumers/consumer.ts).
- Guide: [server actions](../guides/server-actions.md).
