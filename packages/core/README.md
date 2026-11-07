# @nestvexa/core

Nestvexa's small NestJS kernel: validated immutable configuration and explicit collision-safe capability registries. Experimental `0.1.0-alpha.0`; this package alone does not install rendering, browser assets, CSRF middleware or Live routes.

## Install and requirements

Registry publication is pending owner authorization; meanwhile install the local tarballs produced by `pnpm build && pnpm test:pack`. Future registry syntax: `pnpm add @nestvexa/core @nestjs/common reflect-metadata rxjs` (equivalently `npm install` or `yarn add`). Peers are `@nestjs/common` ^12, `reflect-metadata` ^0.2.2 and `rxjs` ^7.8.1; there are no runtime dependencies. Node 22+ and TypeScript legacy decorators (`experimentalDecorators` and `emitDecoratorMetadata`) are required. The package is ESM; its `default` export condition lets CommonJS hosts load it through `require(esm)`.

Architecture role: core is the dependency-free base of the stack. The `nestvexa` umbrella depends on it and re-exports its public API, and `NestvexaModule.forRoot` passes its third argument to `CoreModule` as the kernel registration, so most applications use core through `nestvexa` rather than installing it directly.

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

Providers are scoped to the importing module unless `global: true` is set. Separate applications receive separate registries. Do not put per-user state in a registry. No dependency on template engines, Live, Inertia, frontend frameworks or DOM globals. HTTP adapter support belongs to higher-level integration packages; no HTTP hooks run on import. Request admission and the action pipeline are enforced by higher-level packages (Live, actions); the kernel services below describe and evaluate policies and build request contexts.

## Typed routes

Generate a typed URL builder from your controllers at build or dev time, without starting the application:

```ts
// scripts/routes.ts (run with tsx before building the client)
import { writeFile } from 'node:fs/promises';
import {
  collectRoutes,
  generateRouteModule,
  moduleControllers,
} from '@nestvexa/core';
import { AppModule } from '../src/app.module.js';

const routes = collectRoutes(moduleControllers(AppModule), {
  globalPrefix: 'api',
});
await writeFile('src/generated/routes.ts', generateRouteModule(routes));
```

```ts
import { route } from './generated/routes.js';
route('users.show', { id: 42 }); // '/api/admin/users/42'
route('users.index', {}, { page: 2 }); // '/api/admin/users?page=2'
// route('users.show') and route('users.missing') are compile errors.
```

- Names default to `<controller>.<method>` (`UsersController.show` becomes `users.show`); override one with `@RouteName('users.profile')`. Duplicate names fail with `DUPLICATE_REGISTRATION`.
- Paths use Nest 12 (path-to-regexp v8) syntax: `:id`, `*splat` (string or array of segments) and optional `{/:id}` groups. A handler with several paths uses the first.
- The generated module is standalone (no imports), so it can ship in browser bundles. Every parameter is percent-encoded, so values cannot add segments, queries or hosts; missing parameters throw.
- `buildPath(template, params, query?)` is the runtime equivalent; it also rejects unknown and non-primitive parameters.
- Limits: `moduleControllers` walks static `@Module` imports and dynamic modules returned by `forRoot`; controllers added only inside `forRootAsync` factories, Nest versioning and host constraints are not reflected. Permission-aware links are not generated: check authorization where you render the link.

## Extensions and legacy plugins

`NestvexaExtension` is the one public extension model (see "Kernel services" below):
capability flags, `register`, `contributeContext`, `shutdown`, plus an optional `version`
and a supported `nestvexa` range that is checked against `NESTVEXA_VERSION` when the
application starts (an excluded version fails startup with `UNSUPPORTED_CAPABILITY`).

```ts
const charts = defineExtension({
  name: 'acme.charts',
  version: '1.2.0',
  nestvexa: '^0.1.0-alpha.0',
  capabilities: { 'island-renderer:acme.charts': { supported: true } },
  register: ({ capabilities, security, diagnostics }) => {
    /* startup only */
  },
});
CoreModule.forRoot(options, { extensions: [charts] });
```

The older plugin contract is a **deprecated adapter** over extensions. A plugin is
`{ manifest: { name, version, nestvexa, capabilities, description? }, setup?(context) }`;
`parsePluginManifest` validates manifests (own data properties only, unknown keys
rejected, npm-style names, semver versions, a supported Nestvexa range and capabilities
from `PLUGIN_CAPABILITIES`: `view-engine`, `state-synthesizer`, `action-policy`,
`storage`, `cache`, `realtime-transport`, `island-renderer`, `cli-generator`,
`instrumentation`, `ui-kit`). Nothing resolves, downloads or evaluates code; strings are
rejected so names and URLs never become imports.

Migration (no behavior is lost):

```ts
// Before (deprecated): a standalone registry the kernel never saw.
const registry = new PluginRegistry({ frameworkVersion: '0.1.0-alpha.0' });
registry.install(chartsPlugin);
registry.seal();

// After: install the plugin as an extension.
CoreModule.forRoot(options, { extensions: [pluginExtension(chartsPlugin)] });
// Or keep the registry for now and hand its plugins to the kernel.
CoreModule.forRoot(options, { extensions: registry.extensions() });
```

`pluginExtension(plugin, { name? })` keeps the plugin's `version` and `nestvexa` range,
declares each manifest capability as the flag `<capability>:<name>` (for example
`ui-kit:acme.nestvexa-charts`), and runs `setup` once from the extension's `register`
hook with `frameworkVersion` and the capabilities other extensions declared. The
extension name is the package name with `@scope/name` written as `scope.name`; pass
`{ name }` when that is not a valid extension name. `registry.extensions()` converts the
installed plugins without running `setup` again. `PluginRegistry` still rejects
duplicates, incompatible ranges and installs after `seal()`, and defaults
`frameworkVersion` to `NESTVEXA_VERSION`. `satisfiesVersion` implements the range subset
(`=`, `>`, `>=`, `<`, `<=`, `^`, `~`, spaces, `||`, prerelease precedence) and is not
deprecated.

## Kernel services

`CoreModule.forRoot(options, registration)` (and `forRootAsync`, and the third
argument of `NestvexaModule.forRoot`) also provides these injectable services:

```ts
CoreModule.forRoot(options, {
  requestContext: {
    resolveTenant: (request) => tenantOf(request),
    resolvePrincipal: (request) => principalOf(request),
  },
  diagnostics: { bufferSize: 512 },
  extensions: [auditExtension],
  errorLogger: appLogger,
  redaction: { keys: ['ssn'] },
});
app.useGlobalFilters(app.get(NestvexaExceptionFilter));
```

- **`RequestContextFactory`**: `create(request)` returns one frozen context per request
  with `correlationId`, a 128-bit `cspNonce`, `tenant`, `session`, `principal` and
  extension contributions; `context.public` holds only `correlationId`, `cspNonce`,
  `tenant` and `authenticated`. A well-formed incoming `x-request-id` (8–128 of
  `A-Za-z0-9._:-`) is reused unless `trustIncomingCorrelation: false`; anything else gets
  a random UUID. Resolver errors and malformed resolver output reject (fail closed).
  `correlationId(request)` is synchronous and stable for the request.
- **`NestvexaExceptionFilter`**: HTTP exceptions keep their body (Live
  `{ statusCode, code }`, validation messages) plus `correlationId`; other errors become
  `500 { statusCode, code: 'INTERNAL_ERROR', message: 'Internal server error',
correlationId }`. Every error response carries `x-request-id`. Server errors are logged
  once, redacted, with the correlation ID, and emitted as a `nestvexa.error` diagnostic.
  Works on Express and Fastify without `@nestjs/core`.
- **Redaction**: `redact(value)`, `createRedactor(options)` and
  `createRedactingLogger(logger)` replace values under sensitive keys (`password`,
  `secret`, `token`, `authorization`, `cookie`, `csrf`, `session`, `apiKey`,
  `snapshot`, `signature`, … plus `keys`) with `[REDACTED]`, scrub `Bearer`/`Basic`
  credentials in strings, bound depth and size, mark cycles and never evaluate getters.
  Error messages are scrubbed of credentials but otherwise logged as written; do not put
  secrets in exception messages.
- **`SecurityPolicyRegistry`**: per-owner `csrf`, `origin`, `snapshot`,
  `action-authorization` and `upload-quota` policies, validated and frozen at
  registration (a snapshot policy must bind state to the identity). `verifyCsrf`,
  `originAllowed`, `authorize` and `uploadAllowed` fail closed (missing policy, thrown
  error or non-`true` result denies); `require(owner, kinds)` asserts registration at
  startup; `report()` lists configuration without functions. A CSRF policy receives
  `verify(request, subject?)`, where `subject` is the identity the feature already
  resolved. Live (`policies` option, owner `live`) and `@nestvexa/uploads` (owner
  `uploads`, including its `upload-quota`) register their policies here and ask the
  registry for every origin, CSRF and authorization decision, so the registry is the
  single source of truth; the `nestvexa` umbrella wires Live automatically.
- **`DiagnosticsRegistry`**: typed `event`, `metric` and `span` records with bounded,
  primitive, key-redacted attributes; `define()` builds a catalog (`strict` rejects
  undefined names); `subscribe()` listeners are isolated; `recent()` reads a bounded
  buffer for tests and devtools; `instrumentation()` adapts it to the Live
  `instrumentation` hook (the umbrella does this by default).
- **Extensions** (`NestvexaExtension`, `defineExtension`): `{ name, version?,
nestvexa?, capabilities?, register?(context), contributeContext?(request), shutdown?() }`.
  The `nestvexa` range is checked when the host is created. At module init,
  capabilities are declared, `register` runs with the capability, security and
  diagnostics registries, and context contributors are attached, in installation order;
  then the capability and security registries are sealed. `shutdown` runs in reverse
  order and one failure does not block the others. Duplicate names fail at startup.

## Compatibility

Packed consumption and the full Node/OS matrix must pass before release; NestJS 12 is the intended peer range, not evidence that every patch has been tested. Changes use the repository Changesets policy. APIs may change during alpha with migration notes. See the [root README](../../README.md) and the [configuration reference](../../docs/reference/configuration.md).

## Status and limits

Status: **Shipped (alpha)**. Configuration, registries, typed routes, the plugin registry and the kernel services (request context, exception filter, redaction, security policy and diagnostics registries, extensions) are implemented and tested on Express and Fastify.

- `NestvexaExceptionFilter` is opt-in (`app.useGlobalFilters(...)`); exception messages are logged as written apart from credential scrubbing.
- Views do not read the CSP nonce from `RequestContextFactory` automatically; hosts pass it.
- `SecurityPolicyRegistry` describes and evaluates policies; Live keeps enforcing its own copy, and `@nestvexa/uploads` does not register its quotas there yet.
- `DiagnosticsRegistry` has no exporter (OpenTelemetry stays in `@nestvexa/observability`).
- `PluginRegistry` is separate from the extension hooks, and no out-of-tree plugin package has been consumed from a tarball.
- Typed routes do not reflect controllers added inside `forRootAsync` factories, Nest versioning or host constraints, and do not generate permission-aware links.

## Testing

```sh
pnpm --filter @nestvexa/core test
```

Runs `tests/core.test.ts` and `tests/core-*.test.ts` (config, kernel services, plugins, typed routes); the tests boot real Nest testing modules and cover factory rejection, isolation, malformed input and registries. Build first with `pnpm --filter @nestvexa/core build` because the tests import `dist`. The import-side-effect check in `tests/architecture-runtime.test.ts` runs in the root suite.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
