# @nestvexa/core

Nestvexa's small NestJS kernel: validated immutable configuration and explicit collision-safe capability registries. Experimental `0.1.0-alpha.0`; this package alone does not install rendering, browser assets, CSRF middleware or Live routes.

## Install and requirements

Use `pnpm add @nestvexa/core @nestjs/common reflect-metadata rxjs` (equivalently `npm install` or `yarn add`). Registry publication is pending owner authorization; use workspace or packed artifacts meanwhile. Node 22+ and NestJS 12, TypeScript legacy decorators (`experimentalDecorators` and `emitDecoratorMetadata`) are required. ESM import is supported; CommonJS `require` is not advertised.

```ts
import { Module } from '@nestjs/common';
import { CoreModule } from '@nestvexa/core';

@Module({
  imports: [
    CoreModule.forRoot({ views: { engine: 'hbs', root: 'src/views' } }),
  ],
})
export class AppModule {}
```

`CoreModule.forRootAsync()` accepts exactly one of `useFactory` (with `inject`/`imports`), `useClass` (a `NestvexaOptionsFactory` instantiated in the module) or `useExisting` (an exported provider). For example, inject a host `ConfigService` into `useFactory: (config: ConfigService) => ({ views: { root: config.getOrThrow('VIEWS_ROOT') } })`. Layer sources explicitly with `mergeNestvexaOptions(fileOptions, nestvexaOptionsFromEnvironment(env), overrides)` — later layers win per key, defaults apply last. Nestvexa never reads environment variables implicitly; `nestvexaOptionsFromEnvironment` maps only the documented `NESTVEXA_*` names from the record you pass. `CoreModule.forRoot(options, { global: true })` (or `global: true` in async options) exposes the providers to feature modules. See the [configuration reference](../../docs/reference/configuration.md).

## Public API and defaults

- `NestvexaConfigService.value`: deeply frozen normalized config. Views default to engine `hbs`, root `src/views`, cache `false`, layout `false` (or a named layout string); Live defaults disabled, `live.client` (`'alpine'`/`'manual'`) is present only when configured; CSRF and authorized-action policy flags default true. Flags are contracts for integrations, not claims that core enforces HTTP security.
- `normalizeOptions(unknown)`: runtime validation, rejects unknown keys, accessor properties and invalid types. It reports every invalid path at once as a `NestvexaConfigError` with `issues: { path, expected }[]`; supplied values never appear in messages.
- `mergeNestvexaOptions(...layers)`, `nestvexaOptionsFromEnvironment(record)`, `NESTVEXA_ENVIRONMENT_VARIABLES`: explicit layering and environment mapping.
- `CollisionSafeRegistry<T>`: `register`, `get`, `has`, `names`, `seal`, `sealed`. Duplicate identifiers fail; explicit sealing prevents later registration. Values are trusted adapter objects and are not cloned or frozen.
- `FeatureCapabilityRegistry`: `register`, `get`, `has`, `names`, `require`, `seal`, `report`. Declarations are supported, supported-but-`degraded` (with a description) or unsupported (with a reason); only unsupported ones fail `require`. Declarations are frozen copies of the known fields.
- `NestvexaError`, `NestvexaConfigError`: typed `code` plus diagnostic message; these are not HTTP error envelopes. `NESTVEXA_ERROR_CODES` documents each code.
- `NESTVEXA_OPTIONS`, `NestvexaOptions`, `NormalizedNestvexaOptions`, `NestvexaAsyncOptions`, `NestvexaOptionsFactory`, `CoreModuleRegistration`, `FeatureCapability`, `NestvexaErrorCode`, `NestvexaConfigIssue`: integration tokens and contracts.

Providers are scoped to the importing module, not global. Separate applications receive separate registries. Do not put per-user state in a registry. No dependency on template engines, Live, Inertia, frontend frameworks or DOM globals. HTTP adapter support belongs to higher-level integration packages; no HTTP hooks run on import. Policy, request scope and action pipeline behavior are not implemented by this package.

## Development and compatibility

Run root `pnpm exec vitest run tests/core.test.ts tests/core-config.test.ts tests/architecture-runtime.test.ts`; `pnpm --filter @nestvexa/core build` builds declarations and ESM output. Tests boot real Nest testing modules and cover factory rejection, isolation, malformed input and registries. See [core tests](../../tests/core.test.ts), [root README](../../README.md) and [changelog](../../CHANGELOG.md). Packed consumption and the full Node/OS matrix must pass before release; NestJS 12 is the intended peer range, not evidence that every patch has been tested.

Maintainer identity and repository/issue URLs await the owner; none are fabricated. Changes use the repository Changesets policy. APIs may change during alpha with migration notes.
