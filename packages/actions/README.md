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

Status: experimental alpha (`0.1.0-alpha.0`), not published. Framework hooks
(React/Vue/Svelte wrappers), streaming results and job tickets are planned for
later phases; the client is framework-neutral today.

## Install

Not yet on the registry. Build local tarballs with `pnpm build && pnpm test:pack`.
Future registry syntax: `npm install @nestvexa/actions` / `pnpm add @nestvexa/actions`.

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

### `ActionsModule.register(options)` / `registerAsync(options)`

Static options (needed before DI resolves): `groups`, `prefix`
(default `/_nestvexa/actions`), `imports`, `errorEnvelope`
(`'actions'` default | `'host'`). Host policy (direct or from `registerAsync`'s
`useFactory` with `inject`):

| Option                                 | Default                    |                                                                                                                                   |
| -------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `origin`                               | required                   | Exact origin or list; the `Origin` header must match.                                                                             |
| `resolveIdentity(request)`             | required                   | `{ subject, tenant?, csrfToken? }` or `null`.                                                                                     |
| `authorize(identity, action, request)` | required                   | Coarse policy for every call, before group guards.                                                                                |
| `csrf.required`                        | `true`                     | Disable only for non-cookie (bearer/mTLS) auth.                                                                                   |
| `csrf.header`                          | `x-nestvexa-csrf`          |                                                                                                                                   |
| `rateLimit`                            | 120/min per tenant+subject | `(ctx) => boolean`, `createFixedWindowRateLimit()`, or `false`.                                                                   |
| `limits.maxBodyBytes`                  | 65536                      | Declared `Content-Length` and re-serialized body.                                                                                 |
| `limits.maxDepth`                      | 32                         | JSON nesting.                                                                                                                     |
| `limits.maxNodes`                      | 10000                      | JSON values.                                                                                                                      |
| `limits.maxOutputBytes`                | 1048576                    |                                                                                                                                   |
| `limits.timeoutMs`                     | 30000                      | Default action deadline.                                                                                                          |
| `limits.maxQueuedPerKey`               | 16                         | Serial queue bound.                                                                                                               |
| `idempotency.store`                    | `MemoryIdempotencyStore`   | `begin/complete/abandon` contract for shared stores.                                                                              |
| `idempotency.ttlMs`                    | 86400000                   | Replay retention.                                                                                                                 |
| `exposeErrorDetails`                   | `false`                    | Development only.                                                                                                                 |
| `onError(event)`                       | logs 5xx via Nest `Logger` | `{ requestId, action, code, status, error }`.                                                                                     |
| `instrumentation`                      | none                       | Structural tracing hook: `nestvexa.action` spans with group/action ids and error codes only (shape of `@nestvexa/observability`). |

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

CLI: `nestvexa-actions-codegen --out <dir> [--project tsconfig.json] [--name actions-client] [--client-module <specifier>] [--check]`.
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

## Testing

Root suites (build first): `tests/actions-metadata.test.ts`, `actions-runtime.test.ts`,
`actions-http.test.ts` (Express and Fastify apps with global/class/method guards,
request-scoped providers, pipes, interceptors, filters and the negative corpus),
`actions-client.test.ts`, `actions-codegen.test.ts` (deterministic output and
`tsc --noEmit` against passing and failing consumer fixtures) and the browser
spec `tests/browser/actions.spec.ts` (Chromium, Firefox, WebKit).

## Caveats

- Global interceptors wrap the action envelope (they see `{ ok, data }`), while
  class/method interceptors see the raw return value. Global exception filters do
  not see action errors unless `errorEnvelope: 'host'` is used; use `onError` for
  telemetry.
- Global guards run before admission (Nest evaluates global guards first).
- Fastify rejects some malformed bodies (for example `__proto__` keys) in its own
  parser with a plain 400 before routing.
- The memory idempotency store, rate limiter and serial locks are process-local;
  multi-instance deployments need shared implementations (Redis adapters arrive
  in a later phase).
- The `ActionInput` name also exists in `@nestvexa/live` with Live semantics;
  import it from the package that owns the class you decorate.

## Project links

See the [security policy](../../SECURITY.md), [changelog](../../CHANGELOG.md),
[server actions guide](../../docs/guides/server-actions.md) and
[ADR 0019](../../docs/adr/0019-universal-server-actions.md). Maintainer and
hosted repository URLs await owner input; MIT licensed.
