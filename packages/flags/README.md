# @nestvexa/flags

Optional, server-enforced feature flags for Nestvexa: a small provider interface,
an in-process rule provider, a fail-closed evaluation service, a Nest guard, an HBS
helper and a Live authorization wrapper. It is **not** part of the default
`nestvexa` install.

Alpha software; consult the root release blockers before production use.

## Why a separate package

Flags are capability checks that controllers, guards and Live policies enforce on
the server. They are not a UI concern, so they live in their own tiny package
instead of `@nestvexa/ui`: applications can gate routes and Live actions without
installing UI or i18n code, and the UI kit stays free of authorization logic.

## Install

The package is not published yet: build local tarballs with
`pnpm build && pnpm test:pack` and install the packed `.tgz` file. Future
registry syntax:

```sh
npm install @nestvexa/flags
pnpm add @nestvexa/flags
yarn add @nestvexa/flags
```

Peers: `@nestjs/common` and `@nestjs/core` 12, `reflect-metadata` 0.2, `rxjs` 7.8.
Node 22.13+ or 24, ESM. No runtime dependencies; it does not depend on other
Nestvexa packages (the HBS helper and Live wrapper are structural).

## Usage

```ts
import {
  FlagGuard,
  FlagRequestContext,
  FlagsModule,
  RequireFlag,
  StaticFlagProvider,
  flagHelpers,
  liveFlagPolicy,
} from '@nestvexa/flags';

const flags = FlagsModule.forRoot({
  flags: ['ai-assistant', 'bulk-export'],
  provider: new StaticFlagProvider({
    'ai-assistant': true,
    'bulk-export': { allow: ['admin-binding'], percentage: 10 },
  }),
  // Derive the context from the authenticated session — never from query/body.
  context: (request) => ({ identity: sessionBinding(request) }),
});

@Controller('reports')
@UseGuards(FlagGuard)
class Reports {
  @Get('export.csv')
  @RequireFlag('bulk-export') // 404 when off (or 403 with denyStatus: 403)
  exportCsv() {}
}
```

Templates (register helpers before `configureNestvexa(app)`):

```ts
app.get(HbsEngine).registerHelpers(flagHelpers());
```

```hbs
{{#if (flag 'bulk-export')}}
  <a href='/reports/export.csv'>Export CSV</a>
{{/if}}
```

The helper reads the precomputed `flags` object of the root view model, so put the
evaluated snapshot there: `{ flags: await flagContext.forRequest(request), ... }`
in a controller, or `@Computed() get flags()` in a Live component (re-evaluated on
each request; never stored in the snapshot).

Live actions (wrap the host `authorize` policy):

```ts
authorize: liveFlagPolicy(
  flagService,
  {
    'assistant-panel': 'ai-assistant',
    'product-table.exportCsv': 'bulk-export',
  },
  (identity, component, action) => hostPolicy(identity, component, action),
);
```

Inside an action, `await flagService.assert('bulk-export', { identity })` throws
`ForbiddenException` when the flag is off.

## Public API

| Export                                                                                            | Purpose                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `FlagContext`                                                                                     | `{ identity?, tenant?, attributes? }` — server-derived, copied and validated (plain data only).                                        |
| `FlagProvider`                                                                                    | `evaluate(flag, context): boolean \| Promise<boolean>` — implement for LaunchDarkly/Unleash/your database.                             |
| `FlagRule`, `StaticFlagProvider`                                                                  | `true`/`false` or `{ enabled?, allow?, deny?, percentage? }`. Precedence: deny, allow, `enabled: false`, percentage, `enabled`.        |
| `rolloutBucket(flag, identity)`                                                                   | Deterministic 0–99 bucket from sha256(`flag:identity`). Percentage rules without an identity are off.                                  |
| `FlagService`, `FlagServiceOptions`                                                               | `flags` (sorted allowlist), `isEnabled(flag, ctx)`, `evaluate(ctx, flags?)` (frozen null-prototype record), `assert(flag, ctx)` (403). |
| `flagFingerprint(values)`                                                                         | Order-independent 16-hex hash of an evaluated record, for cache keys.                                                                  |
| `flagHelpers()`, `FlagHelper`                                                                     | HBS `flag` helper: true only for an own boolean `true` in the root `flags` object.                                                     |
| `RequireFlag(flag)`, `REQUIRE_FLAG`                                                               | Method/class metadata read by `FlagGuard`.                                                                                             |
| `FlagGuard`                                                                                       | `CanActivate`; undecorated routes pass; disabled → `NotFoundException` (default) or `ForbiddenException`.                              |
| `FlagRequestContext`                                                                              | `forRequest(request)` evaluates all flags once per request object (WeakMap memo).                                                      |
| `FlagsModule.forRoot(options)`, `FlagsModuleOptions`, `FLAGS_OPTIONS`                             | Provides/exports `FlagService`, `FlagRequestContext`, `FlagGuard`; options add `context(request)` and `denyStatus` (403/404).          |
| `liveFlagPolicy(service, requirements, authorize, context?)`, `LiveAuthorize`, `LiveFlagIdentity` | Wraps a Live `authorize` policy; keys `component` or `component.action`; flags checked first.                                          |
| `assertFlagName(name)`                                                                            | Name grammar: lowercase words joined by `-`, `_` or `.`, ≤ 64 characters.                                                              |

## Defaults and failure behavior

- Unknown flag names throw (typos never silently enable or disable features);
  `liveFlagPolicy` and `RequireFlag` validate names when defined.
- Provider exceptions, timeouts (`timeoutMs`, default 1000) and non-boolean values
  evaluate to `false` and are reported to `onError`. A failing context resolver
  turns every flag off for that request.
- Rule tables reject `__proto__`/`constructor`/`prototype`, accessors, unknown
  fields and invalid percentages.

## Security and cache isolation

- Flags are evaluated only on the server from trusted context. Query strings,
  bodies, headers or cookies chosen by the client never enable a flag.
- Hiding a link is not enforcement: gate the route with `FlagGuard` and Live
  actions with `liveFlagPolicy` (including `$mount`).
- Rendered HTML depends on the evaluated flags. Include `flagFingerprint(values)`
  (and the identity/tenant scope) in any shared cache key, or send
  `Cache-Control: private` / `no-store`. Never cache per-user flag output under a
  shared key.
- Live snapshots should not store flags; expose them through `@Computed` so they
  are re-evaluated per request and a revoked flag takes effect on the next action.
- Do not encode flags in realtime channel names or URLs.

## Compatibility and links

Node 22.13+/24, NestJS 12. The guard uses the standard Nest `CanActivate` API.
[`examples/admin-i18n`](../../examples/admin-i18n/README.md) gates an assistant
panel and an export route with flags (`ai-assistant` on, `bulk-export` off).

## Status and limits

Status: **Shipped (alpha)**. The provider interface, rule provider, fail-closed
service, guard, HBS helper and Live wrapper are implemented and tested.

- `StaticFlagProvider` is in-process configuration; changing rules requires a
  restart or your own provider. There is no flag management UI or remote sync,
  and no adapter for a hosted flag service ships.
- The Nest guard tests run on Express only; Fastify is not exercised.

## Testing

```sh
pnpm --filter @nestvexa/flags test
```

Runs `tests/flags-core.test.ts` (rules, buckets, service failure behavior,
helper, Live wrapper) and `tests/flags-nest.test.ts` (module, guard and
per-request memoization in a Nest Express app); build first with
`pnpm --filter @nestvexa/flags... build` because the tests import `dist`.
`tests/browser/admin-i18n.spec.ts` covers the flagged example through the root
Playwright config.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
