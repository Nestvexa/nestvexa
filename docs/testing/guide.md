# Testing Nestvexa applications

Nestvexa runs inside ordinary Nest routes, so you test it the way you test any
Nest app: build a module with `@nestjs/testing`, start a real HTTP server on an
ephemeral port and send real requests. This guide shows the patterns this
repository uses for its own suites, adapted for application code. Prefer real
HTTP over calling component methods directly: guards, pipes, CSRF, origin and
ownership checks only run on the generated routes.

## What to test where

| Layer                       | Tool                                     | Proves                                                                  |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Pure rules and validators   | Vitest (or Jest)                         | Domain rules, `@State({ validate })` callbacks, schema adapters         |
| Live, actions, Inertia HTTP | Vitest + `@nestjs/testing` + Node `http` | Authorization, CSRF/origin, revision locks, rendered HTML, status codes |
| Browser behavior            | Playwright against your started server   | Directives, morphing, focus, loading states, accessibility              |

## Boot a real Nest app in a test

Compile a testing module with the real `NestvexaModule.forRoot(...)` registration,
call `configureNestvexa(app)` and listen on port `0`:

```ts
const module = await Test.createTestingModule({
  imports: [NestvexaModule.forRoot(config, registration)],
  controllers: [Pages],
}).compile();
const app = module.createNestApplication({ logger: false });
await configureNestvexa(app);
await app.listen(0, '127.0.0.1');
const base = await app.getUrl();
// …
await app.close(); // in afterEach
```

Use a deterministic test identity policy, for example one that reads an
`x-test-user` header and returns a fixed CSRF token. That keeps tests readable,
but **never ship it**: production identity must come from your authenticated
session. [`tests/umbrella-live.test.ts`](../../tests/umbrella-live.test.ts) runs
the same suite on Express and Fastify with `describe.each`.

## Call Live actions over HTTP

Mount the page with `GET`, read the opaque snapshot reference from the rendered
root and post a protocol envelope to `/_nestvexa/live/<component>/<action>`:

<!-- snippet: tests/umbrella-live.test.ts -->

```ts
function payload(html: string, input: unknown = null) {
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  if (!snapshot) throw new Error('Missing fixture snapshot');
  return {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot,
    revision: 0,
    updates: {},
    input,
  };
}
```

Send it as `application/json` with the exact `origin` header and the session's
CSRF token in `x-nestvexa-csrf`. A successful action returns `201` with
`{ component: { revision }, state, html }`. Put writable field changes in
`updates`; non-writable fields return `422`. Model synchronization uses
`POST /_nestvexa/live/<component>/_sync` and the `$sync` policy action.

## Write the negative tests

Most security value is in the rejections. This test from the repository checks
a foreign origin, a bad CSRF token and another owner's snapshot before the
accepted call (the same test then asserts that replaying the snapshot is `409`):

<!-- snippet: tests/umbrella-live.test.ts -->

```ts
      expect(
        (
          await send(app, endpoint, body, {
            origin: 'https://attacker.invalid',
            'x-umbrella-owner': 'owner-a',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send(app, endpoint, body, {
            'x-nestvexa-csrf': 'bad',
            'x-umbrella-owner': 'owner-a',
          })
        ).status,
      ).toBe(403);
      expect(
        (await send(app, endpoint, body, { 'x-umbrella-owner': 'owner-b' }))
          .status,
      ).toBe(410);
      const accepted = await send(app, endpoint, body, {
```

Also assert that your `authorize` callback denies actions a role must not call
(`403`), that guards on `@Action()` methods run, and that a reused snapshot after
a successful action returns `409`.

### Test a custom guard on an `@Action()` method

A Live action is a real Nest route, so a method guard is an ordinary
`CanActivate` that reads the request. This guard (from the repository's
pipeline suite) refuses a request carrying `x-deny: yes`; it is attached with
`@UseGuards(MethodGuard)` next to `@Action()` on the component method:

<!-- snippet: tests/live-pipeline.test.ts -->

```ts
@Injectable()
class MethodGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    events.push('method-guard');
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>().headers;
    return headers['x-deny'] !== 'yes';
  }
}
```

Call the action over HTTP once accepted and once denied. The denied call is a
`403`, and neither the action's pipes nor any component lifecycle hook ran:

<!-- snippet: tests/live-pipeline.test.ts -->

```ts
const denied = await send(
  app,
  '/_nestvexa/live/pipeline/run',
  envelope({ ...marker(html, 'pipeline'), revision: 1 }, { input: 1 }),
  { 'x-deny': 'yes' },
);
expect(denied.status).toBe(403);
expect(events).not.toContain('param-pipe');
expect(events.some((entry) => entry.startsWith('parent:'))).toBe(false);
```

The same pattern applies to universal server actions (`@ServerAction()`): see
the global, class and method guard cases in
[`tests/actions-http.test.ts`](../../tests/actions-http.test.ts).

## Test universal server actions

Actions are `POST /_nestvexa/actions/<group>/<action>` with body `{ "input": … }`,
the exact `origin`, `content-type: application/json` and `x-nestvexa-csrf`
(a Nest global prefix applies on top). Responses use the
`nestvexa-actions/1` envelope: `{ ok: true, data }` or
`{ ok: false, error: { code } }`. See
[`tests/actions-http.test.ts`](../../tests/actions-http.test.ts) and the
[actions README](../../packages/actions/README.md#testing).

## Test Inertia responses

Send Inertia visits with `X-Inertia: true` and `X-Inertia-Version`, then assert on
the JSON page object, partial-reload headers and version conflicts:

<!-- snippet: tests/inertia-http.test.ts -->

```ts
expect(conflict.status).toBe(409);
expect(header(conflict, 'x-inertia-location')).toBe('/lazy?x=1');
expect(header(conflict, 'x-inertia-version')).toBe('v1');
```

A first visit without `X-Inertia` returns full HTML containing the page object
for the official client. Test validation by posting invalid data and asserting the
redirect (`302`, or `303` after `PUT`/`PATCH`/`DELETE`) and the errors on the
following page. More cases:
[`tests/inertia-http.test.ts`](../../tests/inertia-http.test.ts) and the
[Inertia guide](../guides/inertia.md).

## Control time

- `MemoryLiveStore({ now: () => now, ttlMs })` takes a clock; create it yourself
  and pass it as the Live policy's `store` to test snapshot expiry.
- Cache, action idempotency, form drafts and Inertia accept `now` options too.
- In Vitest, `vi.useFakeTimers()` drives debounce and timers in pure code.
- In Playwright, `page.clock.install()` / `page.clock.runFor(ms)` drive polling and
  timers in the browser, as in
  [`tests/browser/activity.spec.ts`](../../tests/browser/activity.spec.ts).

## Browser tests with Playwright

Start your built app with Playwright's `webServer` option on a fixed port and
point tests at it. Assert on what users see, check for page errors and run axe:

<!-- snippet: tests/browser/projects.spec.ts -->

```ts
async function open(page: Page, path = '/projects') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  await expect(page.locator('#project-list > li')).toHaveCount(4);
  return errors;
}
```

Use separate `browser.newContext()` instances for different users or sessions,
and `page.route()` to simulate server failures (the projects spec does this to
test optimistic rollback). Wait on visible state, not fixed timeouts; see
[browser fixtures](browser-fixtures.md) for the scheduling and cleanup rules this
repository follows.

## How this repository's suites are organised

| Script                  | Contents                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit`        | Pure modules: protocol parsers, client helpers, adapters, validators                                                                                                                                                                                                                                                                                  |
| `pnpm test:integration` | Real Nest apps over HTTP on Express and Fastify, CLI end-to-end                                                                                                                                                                                                                                                                                       |
| `pnpm test:security`    | The negative and attack-oriented files (overlaps with the groups above)                                                                                                                                                                                                                                                                               |
| `pnpm test:e2e`         | Playwright in Chromium, Firefox and WebKit against the started examples                                                                                                                                                                                                                                                                               |
| `pnpm test:pack`        | Packs every package and installs the tarballs into external npm/pnpm consumers                                                                                                                                                                                                                                                                        |
| `pnpm test:coverage`    | Vitest with the thresholds in [coverage gates](coverage.md)                                                                                                                                                                                                                                                                                           |
| `pnpm test:services`    | Real Redis (two processes, restart, job queue, presence), S3-compatible storage and ClamAV when their env vars are set ([guide](../guides/production-services.md)); with Redis it also drives four Nest replicas (Express and Fastify) behind one proxy, plus two showcase instances on the same Redis, in Chromium (`playwright.services.config.ts`) |
| `pnpm test:property`    | fast-check property and fuzz suites, including browser runtime fuzzing ([property, load and mutation](property-load-mutation.md))                                                                                                                                                                                                                     |
| `pnpm test:mutation`    | StrykerJS over the highest-risk server modules (score reported, not gating)                                                                                                                                                                                                                                                                           |
| `pnpm load`             | autocannon load and memory soak (starter, Live actions, realtime hub) with heap-growth gates                                                                                                                                                                                                                                                          |

Integration tests import built `dist` output, so run `pnpm build` first. Manual
accessibility checks are listed in the
[accessibility checklist](accessibility-checklist.md).

Where each runs: `ci.yml` runs format, typecheck, lint, `pnpm test`, coverage,
size, e2e, pack and docs on every push; `services.yml` runs `pnpm test:services`
against a Redis service container on every push; `nightly.yml` runs the e2e
suite per browser, `pnpm test:property` with 10x runs and browser fuzzing in
Chromium, Firefox and WebKit, `pnpm test:security`, `pnpm test:mutation` and
a 10-minute `pnpm load` soak. The [test matrix](../contributing/test-matrix.md)
lists every gate.

> **Known gap:** there is no `@nestvexa/testing` helper package yet; the request
> helpers above are copied into each test file (Inertia has
> `@nestvexa/inertia/testing`). Mutation scores are reported, not gating, and
> nightly load latency budgets are advisory on hosted runners. A manual
> assistive technology review is still open.
