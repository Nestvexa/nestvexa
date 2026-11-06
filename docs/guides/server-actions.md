# Server actions

`@nestvexa/actions` lets browser code call selected Nest methods with a typed
client while Nest guards, pipes, interceptors, filters and request scopes run
exactly as for a controller. Use it for page scripts, islands and other non-Live
UI. Live components keep using `@Action` in `@nestvexa/live`.

The design rationale is in [ADR 0019](../adr/0019-universal-server-actions.md);
the full API reference is the [package README](../../packages/actions/README.md).

## 1. Write an action group

A group is a thin, explicitly exposed facade over business services.

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
    return this.cart.add(context.identity.subject, input);
  }

  @ServerAction({ id: 'summary' })
  summary(@ActionContext() context: ActionContext): CartSummary {
    return this.cart.summary(context.identity.subject);
  }
}
```

Only decorated methods of registered groups become routes:
`POST /_nestvexa/actions/cart/add-item` and `/cart/summary`.

## 2. Register it with a host policy

```ts
ActionsModule.register({
  groups: [CartActions],
  imports: [CartModule],
  origin: 'https://shop.example',
  resolveIdentity(request) {
    const session = (request as { session?: AppSession }).session;
    if (!session?.csrf) return null;
    return {
      subject: session.userId ?? `guest:${session.id}`,
      tenant: session.tenantId,
      csrfToken: session.csrf,
    };
  },
  authorize: (identity, action) => permissions.can(identity, action),
});
```

- `resolveIdentity` reads verified server state only. Never trust `userId` or
  `tenantId` from the body; the tests prove body claims are ignored.
- `authorize` runs for every call; guards on the group add per-action checks.
- Use `registerAsync({ groups, imports, inject, useFactory })` when the policy
  depends on configuration or services.

## 3. Generate the typed client

```sh
nestvexa-actions-codegen --project tsconfig.json --out web/generated
```

or from a build script:

```js
import { generateActionClient } from '@nestvexa/actions/codegen';
const result = await generateActionClient({
  project: 'tsconfig.json',
  outDir: 'web/generated',
});
if (!result.ok) process.exit(1);
```

This writes `actions-client.js` (a frozen manifest) and `actions-client.d.ts`
(types derived from the TypeScript checker). Run with `--check` in CI to fail
when generated files are stale. Generated files are deterministic, so they can
be committed or produced during the build.

## 4. Call it from the browser

```html
<meta name="nestvexa-csrf" content="{{csrf}}" />
```

```ts
import {
  createActionsClient,
  isActionClientError,
} from '@nestvexa/actions/client';
import { createActions } from './generated/actions-client.js';

const actions = createActions(
  createActionsClient({
    onNotifications: (list) => toast(list),
  }),
);

const controller = new AbortController();
try {
  const cart = await actions.cart.addItem(
    { productId: 'nest-mug', quantity: 1 },
    { signal: controller.signal },
  );
  render(cart); // cart.updatedAt is typed as string (JSON)
} catch (error) {
  if (isActionClientError(error)) showError(error.code, error.issues);
}
```

The client is framework-neutral and has no Node or Nest imports; bundle it with
your page script (the example uses esbuild) under a strict `script-src 'self'`
CSP.

## 5. Framework bindings, typed errors and optimistic updates

Generate bindings next to the client:

```sh
nestvexa-actions-codegen --project tsconfig.json --out web/generated --targets react,vue,svelte,live
```

```tsx
// React
const hooks = createActionHooks(actions);
function AddButton() {
  const add = hooks.useCartAddItem({
    optimistic: (cart, input) => withPendingLine(cart, input), // CartAddItemOptimistic
    onError: (error) => focusField(error.issues[0]?.path[0]), // 'productId' | 'quantity' | undefined
  });
  return (
    <button
      disabled={add.pending}
      onClick={() => add.run({ productId: 'mug', quantity: 1 })}
    >
      Add
    </button>
  );
}
```

- Vue: `createActionComposables(actions).useCartAddItem()` returns `{ state, run, reset, abort }`
  where `state` is a shallow ref disposed with the component scope.
- Svelte: `createActionStores(actions).cartAddItem()` is a store (`$add.pending`).
- Live/HBS pages: `createActionBindings(actions).bindCartAddItem(form, { input: (form) => ({ ... }) })`
  wires a server-rendered form or button, reflects `aria-busy` /
  `data-nv-action-state`, marks invalid fields (`aria-invalid`) and fills
  `[data-nv-error-for=<field>]`.

All bindings share `createActionController`: `run` never rejects for action
failures (it resolves `{ ok, data } | { ok: false, error }`), a newer call
aborts the previous one, and optimistic data is rolled back on failure. The
generated `CartAddItemError` type is `ActionFailure<'productId' | 'quantity'>`,
so validation issues are typed by field. `settle(promise)` gives the same
discriminated result for plain calls.

## 6. Long-running work: job tickets

Declare `@ServerAction({ id: 'export-report', job: true })` and return
`acceptJob('export-report', async ({ progress, signal }) => result)`. Configure
`jobs: { queue: jobRunnerQueue(new JobRunner()), channel: JobRunner.channel }`
(any object with `enqueue`/`get`/`cancel` works; `@nestvexa/realtime` is not a
dependency). The
call answers `202`; the generated method resolves to a job handle:

```ts
const job = await actions.reports.exportReport({ rows: 100 });
const file = await job.wait({ onProgress: (s) => bar(s.progress), signal });
// or subscribe to job.stream?.channel through @nestvexa/realtime
```

Status polling and cancellation (`<prefix>/_jobs/status|cancel`) pass the same
admission and host policy (`authorize` sees group `_jobs`) and only the owner
can see or cancel a job.

## Validation

Prefer one of:

- a Nest pipe or `ValidationPipe` with a DTO class: `@ActionInput(new ValidationPipe({ whitelist: true }))`;
  message arrays become `error.issues`;
- a runtime schema: `@ServerAction({ id, input: schema, output: schema })`
  accepting any object with `safeParseAsync`, `safeParse` or `parse` (Zod works).
  Schemas run after pipes; their parsed value (with unknown keys stripped by Zod
  objects) is what the method receives.

Always copy only known fields (mass-assignment defense) and check resource
ownership against `context.identity`, as the tenant-isolation test does.

## Idempotency, concurrency and timeouts

`idempotent: true` makes the `Idempotency-Key` header mandatory. The generated
client sends a fresh key per call; pass `{ idempotencyKey }` to retry the same
logical operation. A replay returns the stored result with
`idempotent-replayed: true`; a concurrent duplicate gets `409 CONFLICT`
(`IDEMPOTENCY_IN_PROGRESS`); reusing a key with different input gets `409`
(`IDEMPOTENCY_MISMATCH`). Failed calls release the key.

`concurrency: 'serial'` runs one call at a time per tenant, subject and group
(bounded queue). Deadlines (`timeoutMs`) abort `@ActionSignal()` and return
`504 TIMEOUT`; pass the signal to I/O so work actually stops. Nothing is wrapped
in an implicit database transaction.

## Results

Return plain data, or `redirectTo('/orders/42', data?)` /
`withNotifications(data, { level: 'success', message: 'Saved' })`. Entities,
`Map`/`Set`, functions and cycles are rejected with `INTERNAL` rather than leaked;
map them to DTOs. `Date` and other `toJSON()` values serialize normally.

## Errors and observability

Every response has `x-nestvexa-request-id`; failures use stable codes. Pass
`instrumentation` (for example `openTelemetryInstrumentation(tracer)` or
`MemoryInstrumentation` from `@nestvexa/observability`) for one
`nestvexa.action` span per call, and `logger` (for example `createLogger()`) for
one structured record per call (request id, action, status, code, duration,
replay, job id; never inputs or identities). `onError` still forwards
`{ requestId, action, code, status, error }` for failures. Keep `exposeErrorDetails` off outside development. If your platform
requires global exception filters to see action errors, set
`errorEnvelope: 'host'`; the client then normalizes plain Nest error bodies by
HTTP status.

## Example and tests

Run `pnpm build` then `pnpm --filter @nestvexa/example-actions-basic start` and
open <http://127.0.0.1:3111>. The [Playwright spec](../../tests/browser/actions.spec.ts)
signs in, calls the typed client through the generated Live/HBS binding, and
verifies that guest, CSRF-less, forged-token and cross-origin calls fail without
side effects. The [hybrid dashboard](../../examples/hybrid-dashboard) calls typed
actions from React (hook), Vue (composable) and Svelte (store) islands and runs
a job action with progress.

## CLI

`nestvexa make:action <Name>` generates an `@ActionGroup`, appends it to `actionGroups` and the deny-by-default `allowedActions` in `src/nestvexa/actions.config.ts` and registers `ActionsModule` once. See the [CLI reference](../reference/cli.md).
