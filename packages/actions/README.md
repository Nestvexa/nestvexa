# @nestvexa/actions

Authorization-first server actions for NestJS. Expose explicitly registered
methods of business-facing classes as POST routes, run them through the real
Nest pipeline (guards, pipes, interceptors, filters, request scopes), and call
them from any browser code through a generated, typed client:

```ts
const cart = await actions.cart.addItem({ productId, quantity }, { signal });
```

This is **not** an RPC endpoint over your services. Nothing is exposed because
it is `@Injectable`, public or named a certain way: a method becomes a route only
when it is decorated with `@ServerAction` on an `@ActionGroup` class **and** that
class is listed in `ActionsModule.register({ groups })`.

Status: experimental alpha (`0.1.0-alpha.0`), not published. The client is
framework-neutral; the code generator can also emit React hooks, Vue
composables, Svelte stores and Live element helpers, and long-running actions
answer `202` with a job ticket (see below).

The package is optional: the `nestvexa` umbrella package does not include it, so
add it next to `nestvexa` (or plain Nest) when you want universal actions. It has
no runtime dependency on other Nestvexa packages; the job queue and telemetry
hooks are structural, so `@nestvexa/realtime` and `@nestvexa/observability` plug
in without being dependencies.

## Install

Not yet on the registry. Build local tarballs with `pnpm build && pnpm test:pack`
and install the packed `.tgz` file. Future registry syntax:
`npm install @nestvexa/actions` / `pnpm add @nestvexa/actions` /
`yarn add @nestvexa/actions`.

Peer dependencies: `@nestjs/common` ^12, `@nestjs/core` ^12, `reflect-metadata`
^0.2.2, `rxjs` ^7.8.2. `typescript` ^6 is an **optional** peer needed only for
the code generator (`@nestvexa/actions/codegen` and the CLI). Node 22.13+/24.
ESM only. Enable `experimentalDecorators` and `emitDecoratorMetadata` as for any
Nest application.

| Entry point                 | Runtime          | Contents                                     |
| --------------------------- | ---------------- | -------------------------------------------- |
| `@nestvexa/actions`         | Node (Nest)      | decorators, `ActionsModule`, errors, results |
| `@nestvexa/actions/client`  | browser/any      | `createActionsClient`, error type, types     |
| `@nestvexa/actions/codegen` | Node, build time | `generateActionClient()`                     |
| `nestvexa-actions-codegen`  | CLI              | wraps `generateActionClient()`               |

The client entry imports nothing from Node, Nest or the compiler (enforced by
`scripts/boundaries.mjs`).

## Usage

```ts
import { Inject, Injectable, UseGuards } from '@nestjs/common';
import {
  ActionContext,
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
} from '@nestvexa/actions';

@Injectable()
@ActionGroup('cart')
@UseGuards(SessionAuthGuard) // normal Nest guard, class level
export class CartActions {
  constructor(@Inject(CartService) private readonly cart: CartService) {}

  @ServerAction({ id: 'add-item', idempotent: true, concurrency: 'serial' })
  add(
    @ActionInput(AddItemPipe) input: AddItemInput, // normal Nest pipe / ValidationPipe DTO
    @ActionContext() context: ActionContext,
  ): CartSummary {
    // Identity comes from the host policy, never from the body.
    return this.cart.add(context.identity.subject, input);
  }
}

@Module({
  imports: [
    ActionsModule.register({
      groups: [CartActions],
      imports: [CartModule], // exports CartService, SessionAuthGuard, AddItemPipe
      origin: 'https://shop.example',
      resolveIdentity: (request) => sessionIdentity(request), // { subject, tenant?, csrfToken } | null
      authorize: (identity, action) => policy.allows(identity, action),
    }),
  ],
})
export class AppModule {}
```

The route is `POST /_nestvexa/actions/cart/add-item` (a Nest global prefix is
applied on top). Generate the client at build time and use it in the browser:

```sh
nestvexa-actions-codegen --project tsconfig.json --out web/generated
```

```ts
import {
  createActionsClient,
  isActionClientError,
} from '@nestvexa/actions/client';
import { createActions } from './generated/actions-client.js';

const actions = createActions(createActionsClient());
try {
  const summary = await actions.cart.addItem({ productId: 'mug', quantity: 1 });
} catch (error) {
  if (isActionClientError(error) && error.code === 'UNAUTHENTICATED')
    showLogin();
}
```

A complete runnable app (HBS page, session sign-in, CSRF, generated client,
Playwright coverage) is in [`examples/actions-basic`](../../examples/actions-basic/README.md).

## Server API

### `@ActionGroup(id)`

Class decorator. `id` is lowercase kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`,
≤ 64 chars). A group class must not also be a `@Controller`.

### `@ServerAction(options)`

| Option        | Default            | Meaning                                                                    |
| ------------- | ------------------ | -------------------------------------------------------------------------- |
| `id`          | required           | Stable public id (kebab-case). Client name is camelCase (`addItem`).       |
| `version`     | none               | Integer 1–1000. Route becomes `<id>/v<version>`, client name `addItemV2`.  |
| `idempotent`  | `false`            | Require an `Idempotency-Key` header and replay stored results.             |
| `timeoutMs`   | `limits.timeoutMs` | Deadline 1–600000 ms; aborts the action signal and returns `TIMEOUT`.      |
| `concurrency` | `'parallel'`       | `'serial'` runs one call at a time per tenant + subject + group.           |
| `input`       | none               | Runtime schema (`safeParseAsync`/`safeParse`/`parse`) applied after pipes. |
| `output`      | none               | Runtime schema applied to the returned data.                               |
| `job`         | `false`            | Long-running: return `acceptJob(...)`, answer 202 with a job ticket.       |

Options are copied once at decoration; accessors, inherited and unknown keys are
rejected. Method-level `@UseGuards`, `@UsePipes`, `@UseInterceptors`,
`@UseFilters`, `@SetMetadata` and `@Header` work as on controllers. Route-shaping
decorators (`@Get/@Post`, `@HttpCode`, `@Render`, `@Redirect`, `@Sse`) are
rejected at startup because the module owns the route. A subclass that overrides
an action method must redeclare `@ServerAction`.

### Parameters

- `@ActionInput(...pipes)` binds the body's `input` member using Nest's own
  `@Body('input', ...pipes)`, so global, method and parameter pipes (including
  `ValidationPipe` with DTO classes) behave exactly as on a controller. At most
  one per method. Actions without it reject non-null input (`UNEXPECTED_INPUT`).
- `@ActionContext()` injects `{ requestId, identity, action, signal, idempotencyKey }`.
  `ActionContext` is also the type.
- `@ActionSignal()` injects the `AbortSignal` (deadline, client disconnect, shutdown).
- Any other Nest parameter decorator (`@Req()`, `@Headers()`, custom) still works.

### Results and errors

Return JSON-safe data: primitives, arrays, plain objects, or objects with
`toJSON()` (for example `Date`, emitted as an ISO string). Functions, symbols,
bigints, non-finite numbers, cycles, `undefined` array items and class instances
without `toJSON()` (entities, `Map`, `Set`, errors) are rejected with
`INTERNAL`/`OUTPUT_NOT_JSON_SAFE` instead of being silently corrupted or leaked.
Map entities to DTOs, or apply `ClassSerializerInterceptor` at class/method level.

- `redirectTo('/orders/42', data?)` and `withNotifications(data, ...notifications)`
  return an `ActionResult`; `ActionResult.of(data, { redirect, notifications })`
  combines both. Redirects must be same-origin absolute paths.
- `throw new ActionError(code, message?, { status?, reason?, issues?, cause? })`
  or the helpers `ActionError.validation/forbidden/unauthenticated/notFound/conflict/rateLimited`.
  Its message, reason and issues are public; `cause` stays on the server.

Success envelope: `{ protocol: 'nestvexa-actions/1', ok: true, requestId, data, redirect?, notifications? }`.
Failure envelope: `{ protocol, ok: false, requestId, error: { code, message, reason?, issues?, detail? } }`.
Every response carries `x-nestvexa-request-id` and `Cache-Control: no-store`.

| Code                | Status  | Typical source                                            |
| ------------------- | ------- | --------------------------------------------------------- |
| `VALIDATION`        | 400/415 | body shape, pipes, input schema, idempotency key format   |
| `UNAUTHENTICATED`   | 401     | `resolveIdentity` returned null, `UnauthorizedException`  |
| `FORBIDDEN`         | 403     | origin, CSRF, host `authorize`, guards                    |
| `NOT_FOUND`         | 404     | `ActionError.notFound()`, `NotFoundException`             |
| `CONFLICT`          | 409     | idempotency in progress/mismatch, application conflicts   |
| `PAYLOAD_TOO_LARGE` | 413     | body bytes, JSON depth or value count                     |
| `RATE_LIMITED`      | 429     | rate limit hook, serial queue or idempotency capacity     |
| `TIMEOUT`           | 504/408 | deadline exceeded / client disconnected                   |
| `INTERNAL`          | 500/503 | unexpected errors, unsafe output, output schema, shutdown |

4xx `HttpException` messages are passed through (as Nest does); `ValidationPipe`
message arrays become `issues`. 5xx and non-HTTP errors always use a generic
message; `detail` is added only when `exposeErrorDetails: true`.

### Long-running actions (202 job tickets)

```ts
@ServerAction({ id: 'export-report', job: true })
exportReport(@ActionInput() input: { rows: number }) {
  return acceptJob('export-report', async ({ progress, signal }) => {
    progress(50); // 0-100
    if (signal.aborted) throw new Error('cancelled');
    return { url: '/reports/1.csv' }; // JSON-safe result, typed for the client
  });
}
// Host policy:
ActionsModule.register({
  /* ... */
  jobs: {
    queue: jobRunnerQueue(new JobRunner()),
    channel: JobRunner.channel,
    pollAfterMs: 500,
  },
});
```

The route answers `202` with `{ ok: true, data: null, job: { id, status, progress, pollAfterMs, stream? } }`
(an idempotent job action replays the same ticket). `POST <prefix>/_jobs/status`
and `/_jobs/cancel` with `{ input: { id } }` go through the same admission
(origin, CSRF, identity, rate limit, body limits), then host `authorize` with
`{ group: '_jobs', action: 'status' | 'cancel' }`, then the queue's owner-bound
`get`/`cancel`. Another identity's job id is a plain `404 JOB_NOT_FOUND`.

`jobs.queue` is the structural `ActionJobQueue` (`enqueue(owner, name, handler, options?)`,
`get(owner, id)`, `cancel?(owner, id)`). `jobRunnerQueue(runner)` adapts
`@nestvexa/realtime`'s name-registered `JobRunner` without a package dependency:
each job name is registered on first use and the accepted work runs in the
process that accepted it. A durable, multi-process queue can implement the same
three methods with serializable work. The owner is derived from the verified identity (default an
opaque tenant + subject hash; `jobs.owner(identity)` lets the realtime host use
its own binding so `JobRunner.authorize` guards the `stream.channel`
subscription). Failures expose only the queue's generic message; job results
follow the same JSON-safety and size limits as action data. Contract errors:
`JOB_REQUIRED` (job action returned something else), `JOB_NOT_DECLARED`
(`acceptJob` without `job: true`), `JOBS_UNAVAILABLE` (no queue, 503).

### Tracing and structured logs

`instrumentation` (`{ start(name, attributes) → { end(outcome, attributes) } }`)
and `logger` (`{ info, warn, error }(message, fields)`) are structurally the
`@nestvexa/observability` interfaces: pass `MemoryInstrumentation`,
`openTelemetryInstrumentation(tracer)`, `combineInstrumentation(...)` or
`createLogger()` directly. Each call records one `nestvexa.action` span
(attributes `nestvexa.action.group/id/version`, `nestvexa.request_id`; ended with
`http.status_code`, `nestvexa.action.code`, `nestvexa.action.reason`,
`nestvexa.action.replayed`, `nestvexa.job.id`) and one `nestvexa.action` log
record (`ActionCallLog`: request id, group, action, version, status, code,
reason, duration, replayed, job id) at info/warn/error for 2xx/4xx/5xx. The
final status is read from the response, so rejections by guards, admission or
host filters are recorded too. Redaction is by construction: inputs, outputs,
identities, headers and error messages are never part of spans or records.
Telemetry failures never affect the response.

With `requestContext` (structural; `RequestContextFactory` from `@nestvexa/core`
fits, so this package still imports no Nestvexa package), the request ID used in
the envelope `requestId`, `x-nestvexa-request-id`, spans and call logs is the
kernel correlation ID (a validated incoming `x-request-id` or the kernel's
random UUID), so it matches kernel error bodies and logs. IDs outside 8–128 of
`A-Za-z0-9._:-` and throwing hooks fall back to a random request ID. Pair it
with `instrumentation: diagnostics.instrumentation()` to record action spans in
the kernel `DiagnosticsRegistry`.

### Kernel policies, identity and features

With `policies` (structural; for example `SecurityPolicyRegistry` from
`@nestvexa/core`), actions register `origin`, `csrf` (only when
`csrf.required` is not false) and `action-authorization` under `policyOwner`
(default `actions`; a second registration fails startup) and ask the registry
for every origin, CSRF and authorization decision. `actionSecurityPolicies` is
the one implementation. Registry authorization uses resource `group` and action
`id` (`id/v<version>` when versioned; `_jobs` uses `status`/`cancel`) and
passes the request, because the host `authorize` receives it: a decision without
a request is denied. Registry decisions fail closed (a throwing host
`authorize` is a 403 `POLICY`); without `policies` a throwing host
`authorize` still fails the call with 500, as before.

`kernelIdentity` (structural; `RequestContextFactory`) attaches the kernel
`principal` to the identity and makes the kernel `tenant` the identity's tenant
(rate-limit keys, job owners, serial keys). A host `subject` that differs from
the principal id or a host `tenant` that differs from the kernel tenant is
`401 UNAUTHENTICATED` with reason `IDENTITY_MISMATCH`; a failing kernel
identity is `IDENTITY_REQUIRED`. `featureRegistry` (`NestvexaRegistry`)
receives feature `policyOwner` with every action as `group/id` and the
`idempotency`, `jobs`, `csrf` and `kernel-identity` capabilities.

### `ActionsModule.register(options)` / `registerAsync(options)`

Static options (needed before DI resolves): `groups`, `prefix`
(default `/_nestvexa/actions`), `imports`, `errorEnvelope`
(`'actions'` default | `'host'`). Host policy (direct or from `registerAsync`'s
`useFactory` with `inject`):

| Option                                 | Default                    |                                                                 |
| -------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `origin`                               | required                   | Exact origin or list; the `Origin` header must match.           |
| `resolveIdentity(request)`             | required                   | `{ subject, tenant?, csrfToken? }` or `null`.                   |
| `authorize(identity, action, request)` | required                   | Coarse policy for every call, before group guards.              |
| `csrf.required`                        | `true`                     | Disable only for non-cookie (bearer/mTLS) auth.                 |
| `csrf.header`                          | `x-nestvexa-csrf`          |                                                                 |
| `rateLimit`                            | 120/min per tenant+subject | `(ctx) => boolean`, `createFixedWindowRateLimit()`, or `false`. |
| `limits.maxBodyBytes`                  | 65536                      | Declared `Content-Length` and re-serialized body.               |
| `limits.maxDepth`                      | 32                         | JSON nesting.                                                   |
| `limits.maxNodes`                      | 10000                      | JSON values.                                                    |
| `limits.maxOutputBytes`                | 1048576                    |                                                                 |
| `limits.timeoutMs`                     | 30000                      | Default action deadline.                                        |
| `limits.maxQueuedPerKey`               | 16                         | Serial queue bound.                                             |
| `idempotency.store`                    | `MemoryIdempotencyStore`   | `begin/complete/abandon` contract for shared stores.            |
| `idempotency.ttlMs`                    | 86400000                   | Replay retention.                                               |
| `exposeErrorDetails`                   | `false`                    | Development only.                                               |
| `onError(event)`                       | logs 5xx via Nest `Logger` | `{ requestId, action, code, status, error }`.                   |
| `instrumentation`                      | none                       | One span per call (see Tracing).                                |
| `logger`                               | none                       | One structured record per call (see Tracing).                   |
| `jobs.queue` / `channel` / `owner`     | none                       | Job queue, streaming channel mapper, owner binding.             |
| `jobs.pollAfterMs`                     | 1000                       | Poll hint in tickets (100-60000).                               |
| `requestContext`                       | none                       | `{ correlationId(request) }`, e.g. `RequestContextFactory`.     |

`authorize` must return exactly `true` (or a promise of it); any other value,
including truthy objects or strings, is a `403 POLICY`, and a throwing policy
fails closed with `500`.

Startup rejects: undecorated classes, empty groups, duplicate group ids, duplicate
`id`+`version`, colliding client names, schemas without `@ActionInput`, invalid
options, the same group registered twice, and route collisions across
registrations in one application. Messages name the classes and routes involved.
`registerAsync` factories cannot add groups or routes and must stay singleton.

Other exports: `ActionsRuntime` (injectable, for diagnostics), `MemoryIdempotencyStore`,
`KeyedMutex`, `createFixedWindowRateLimit`, `runSchema`, `isActionSchema`,
`actionGroupDefinition`, `isActionGroup`, `inspectJsonInput`, `toJsonSafe`,
`codeForStatus`, `isSafeRedirect`, `actionKey`, protocol constants and types.

## Client API (`@nestvexa/actions/client`)

`createActionsClient(options)`: `baseUrl` (default same origin), `prefix`
(must match the server, including any global prefix), `fetch`, `csrf` (string or
getter; default `<meta name="nestvexa-csrf" content>`), `csrfHeader`,
`credentials` (`same-origin`), `headers`, `onRedirect` (default
`location.assign` for safe paths), `onNotifications`, `createIdempotencyKey`
(default `crypto.randomUUID`).

- `client.call(descriptor, input, { signal, timeoutMs, idempotencyKey, headers })`
- `client.bind(manifest)` builds `{ group: { action(input, options) } }`; the
  generated `createActions(client)` returns it with full types.
- Failures reject with `ActionClientError { code, status, reason, issues, requestId, detail }`;
  non-envelope responses (host filters, proxies) are normalized by status.
  Aborts reject with the signal's reason. Fetch redirects are treated as errors.
- Idempotent actions get a fresh key per call unless you pass `idempotencyKey`;
  reuse the same key yourself when retrying.
- Job actions resolve to an `ActionJobHandle<T>`: `status()`, `wait({ intervalMs, timeoutMs, signal, onProgress })`
  (rejects with reason `JOB_FAILED`/`JOB_CANCELLED`/`JOB_WAIT`), `cancel()` and
  `stream?.channel`. `client.job(idOrTicket)` re-attaches after a reload.
- `settle(promise)` returns `{ ok: true, data } | { ok: false, error: ActionFailure<Field> }`
  where `error.issues[n].path[0]` is typed as the action's input field union.
- `createActionController(method, { initialData, optimistic, abortPrevious, onSuccess, onError })`
  is the framework-neutral state machine behind the generated bindings:
  `getSnapshot()` (`status`, `pending`, `data`, `error`, `optimistic`),
  `subscribe` (Svelte store contract), `listen` (no immediate call),
  `run(...)` (never rejects for action failures), `reset()`, `abort()`.
  Optimistic data is rolled back on failure or abort; a newer call aborts the
  previous one by default and stale results are ignored.
- `bindActionElement(element, method, { input, event?, onSettled, ...controllerOptions })`
  binds a server-rendered form or button (Live/HBS pages): `aria-busy` and
  `data-nv-action-state` reflect the call, issues set `aria-invalid` on
  `[name=<field>]` and fill `[data-nv-error-for=<field>]` with text, and a
  bubbling `nv:action` event carries the outcome. Returns an unbind function.
- `isActionClientError` also recognizes errors created by another bundled copy
  of the client (for example inside a separately built island chunk).

## Code generation (`@nestvexa/actions/codegen`)

`generateActionClient({ project | files, compilerOptions?, outDir, fileName = 'actions-client', clientModule = '@nestvexa/actions/client', write = true, check = false })`
uses the TypeScript compiler API: decorators are resolved through import aliases
to this package's exports, ids and versions must be literals, and parameter and
return types are read from the checker (inherited actions included). Types are
emitted structurally with JSON semantics: `Date`/`toJSON()` become their JSON
type, `ActionResult<T>` unwraps to `T`, `void` outputs become `null`,
`T | undefined` properties become optional, methods/private members are dropped,
named interfaces/aliases/enums become declarations (collisions get `_2`), and
`Map`/`Set`/functions/bigint are reported as errors. Output is deterministic
(sorted, no timestamps, `\n` line endings) and unchanged files are not rewritten.
Errors produce diagnostics with file/line and nothing is written.

Each method is emitted as `ActionMethod<Input, Output, Field>`, where `Field` is
the union of top-level input property names (`never` without input), and per
action the aliases `<Group><Action>Input`, `Output`, `Error`
(`ActionFailure<Field>`, the typed validation-error union) and `Optimistic`
(`ActionOptimisticUpdate<Output, Input>`). Job actions are emitted as
`ActionMethod<Input, ActionJobHandle<Result>, Field>` with `Result` taken from
`acceptJob`'s handler.

`targets: ['react', 'vue', 'svelte', 'live']` also writes
`<name>.<target>.js/.d.ts`:

| Target   | Export                             | Per action (e.g. `cart.addItem`)                                                                 |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `react`  | `createActionHooks(actions)`       | `useCartAddItem(options?)` → state + `run/reset/abort` (`useSyncExternalStore`)                  |
| `vue`    | `createActionComposables(actions)` | `useCartAddItem(options?)` → `{ state: shallowRef, run, reset, abort }`, disposed with the scope |
| `svelte` | `createActionStores(actions)`      | `cartAddItem(options?)` → store (`$store`) with `run/reset/abort`                                |
| `live`   | `createActionBindings(actions)`    | `bindCartAddItem(element, options)` → unbind (Live/HBS pages)                                    |

The JavaScript of the React and Vue targets imports the framework in your
application; the declarations only import `@nestvexa/actions/client`, so they
typecheck without framework types and this package never depends on a
framework.

CLI: `nestvexa-actions-codegen --out <dir> [--project tsconfig.json] [--name actions-client] [--client-module <specifier>] [--targets react,vue,svelte,live] [--check]`.
Exit codes: 0 ok, 1 diagnostics or out of date (`--check`), 2 usage.

## Security model

Pipeline per request: Nest global guards → **admission** (first class guard:
POST only, exact `Origin`, `application/json` only, declared size, identity,
constant-time CSRF comparison, rate limit, body shape/depth/size, prototype
pollution keys `__proto__`/`constructor`/`prototype`, idempotency key, host
`authorize`) → group class guards → method guards → envelope interceptor
(deadline, idempotency replay, serial lock) → application interceptors → pipes →
input schema → method → output schema → JSON-safe envelope. Filters: method and
class filters on the group win; the actions envelope filter is the last resort.

- Identity is never read from the body; tenant and subject come from `resolveIdentity`.
- Every call is authorized by `authorize` and by your guards. Obscure ids are not a control.
- Idempotency keys are scoped by tenant, subject, group, action and version,
  hashed before storage, and bound to a canonical input fingerprint (reuse with
  different input is a `CONFLICT`). Results of successful calls are replayed;
  failures release the key. A duplicate while the first call runs gets `409`.
- Locks and idempotency records follow the real work: a timed-out call keeps
  them until the handler settles, so a retry cannot run concurrently with it.
- No implicit database transactions. A timeout aborts the signal but cannot
  undo work; services must honor `AbortSignal` and own their transactions.
- Logs never include inputs; the default logger records 5xx with request id.

## Project links

See the [security policy](../../SECURITY.md),
[server actions guide](../../docs/guides/server-actions.md) and
[ADR 0019](../../docs/adr/0019-universal-server-actions.md). MIT licensed.

## Status and limits

Status: **Shipped (alpha)**. Registration, admission, the Nest pipeline, typed
codegen with framework targets, `202` job tickets and per-call tracing and logs
are implemented and covered by HTTP, codegen and browser tests.

- Global interceptors wrap the action envelope (they see `{ ok, data }`), while
  class/method interceptors see the raw return value. Global exception filters do
  not see action errors unless `errorEnvelope: 'host'` is used; use `onError` for
  telemetry.
- Global guards run before admission (Nest evaluates global guards first).
- Fastify rejects some malformed bodies (for example `__proto__` keys) in its own
  parser with a plain 400 before routing.
- The memory idempotency store, rate limiter and serial locks are process-local;
  multi-instance deployments need shared implementations of the same contracts
  (no Redis adapter ships for them yet). `jobRunnerQueue` runs accepted work in
  the accepting process; a durable queue is host-supplied.
- Results are a single JSON envelope or a job ticket; there is no incremental
  streaming of an action's return value (progress streams through the job
  `stream.channel`).
- Coexistence with Nest GraphQL or microservice transports is untested.
- The `ActionInput` name also exists in `@nestvexa/live` with Live semantics;
  import it from the package that owns the class you decorate.

## Testing

```sh
pnpm --filter @nestvexa/actions test
```

Runs the root suites `tests/actions-*.test.ts` (build first with
`pnpm --filter @nestvexa/actions... build`, since tests import `dist`):
metadata, runtime, `actions-http.test.ts` (Express and Fastify apps with
global/class/method guards, request-scoped providers, pipes, interceptors,
filters and the negative corpus), client, `actions-codegen.test.ts`
(deterministic output, framework targets and `tsc --noEmit` against passing and
failing consumer fixtures), `actions-jobs.test.ts` (202 tickets, owner-bound
polling and cancellation over Express and Fastify, `JobRunner` compatibility,
spans and redacted logs), `actions-security.test.ts` (expired/tampered tokens,
expired idempotency records, non-boolean policies, unguarded groups) and
`actions-client-state.test.ts` (controller, `settle`, element binding in
Chromium). The browser specs `tests/browser/actions.spec.ts` and
`tests/browser/islands.spec.ts` (typed actions from React, Vue and Svelte
islands) run through the root Playwright config.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
