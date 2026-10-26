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

`CoreModule.forRootAsync({ imports, inject, useFactory })` supports async configuration and normal Nest module visibility. For example, inject a host `ConfigService` into `useFactory: (config: ConfigService) => ({ views: { root: config.getOrThrow('VIEWS_ROOT') } })`. The host chooses file/environment precedence; explicit factory or module values override defaults. Nestvexa never reads environment variables implicitly.

## Public API and defaults

- `NestvexaConfigService.value`: deeply frozen normalized config. Views default to engine `hbs`, root `src/views`, cache `false`, layout `false` (or a named layout string); Live defaults disabled; CSRF and authorized-action policy flags default true. Flags are contracts for integrations, not claims that core enforces HTTP security.
- `normalizeOptions(unknown)`: runtime validation, rejects unknown keys, accessor properties and invalid types. Secrets and unknown supplied values are omitted from diagnostic messages.
- `CollisionSafeRegistry<T>`: `register`, `get`, `has`, `names`, `seal`, `sealed`. Duplicate identifiers fail; explicit sealing prevents later registration. Values are trusted adapter objects and are not cloned or frozen.
- `FeatureCapabilityRegistry`: `register`, `get`, `names`, `require`, `seal`. Unsupported capabilities require a reason; declarations are frozen.
- `NestvexaError`: typed `code` plus diagnostic message; this is not an HTTP error envelope.
- `NESTVEXA_OPTIONS`, `NestvexaOptions`, `NormalizedNestvexaOptions`, `NestvexaAsyncOptions`, `FeatureCapability`, `NestvexaErrorCode`: integration tokens and contracts.

Providers are scoped to the importing module, not global. Separate applications receive separate registries. Do not put per-user state in a registry. No dependency on template engines, Live, Inertia, frontend frameworks or DOM globals. HTTP adapter support belongs to higher-level integration packages; no HTTP hooks run on import. Policy, request scope and action pipeline behavior are not implemented by this package.

## Development and compatibility

Run root `pnpm exec vitest run tests/core.test.ts`; `pnpm --filter @nestvexa/core build` builds declarations and ESM output. Tests boot real Nest testing modules and cover factory rejection, isolation, malformed input and registries. See [core tests](../../tests/core.test.ts), [root README](../../README.md) and [changelog](../../CHANGELOG.md). Packed consumption and the full Node/OS matrix must pass before release; NestJS 12 is the intended peer range, not evidence that every patch has been tested.

Maintainer identity and repository/issue URLs await the owner; none are fabricated. Changes use the repository Changesets policy. APIs may change during alpha with migration notes.
