# Configuration reference

`@nestvexa/core` validates and freezes the application options that
`NestvexaModule.forRoot()` / `forRootAsync()` (umbrella) and `CoreModule` receive.
Nestvexa never reads environment variables or files on its own; the host decides what
to pass and in which order.

## Options and defaults

| Path                                | Type                      | Default     | Notes                                                                                                                                                                       |
| ----------------------------------- | ------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `views.engine`                      | lowercase name            | `'hbs'`     | The umbrella supports `hbs` only; other engines register explicitly.                                                                                                        |
| `views.root`                        | non-empty string          | `src/views` | Resolved by the host process; Windows paths are kept verbatim.                                                                                                              |
| `views.cache`                       | boolean                   | `false`     | Use `true` for immutable deployed templates.                                                                                                                                |
| `views.layout`                      | string or `false`         | `false`     | Default layout view.                                                                                                                                                        |
| `views.namespaces`                  | object: name -> directory | absent      | `admin::users/index` resolves in that directory; the app overrides at `<root>/vendor/<name>/`. Names match `/^[a-z][a-z0-9-]{0,63}$/`, at most 64. No environment variable. |
| `views.themes`                      | object: name -> directory | absent      | Theme override directories selected per render (`RenderOptions.theme`). Same name rules. No environment variable.                                                           |
| `live.enabled`                      | boolean                   | `false`     | Must match an explicit umbrella Live registration.                                                                                                                          |
| `live.client`                       | `'alpine'` / `'manual'`   | unset       | When set, must equal the umbrella browser mode (`live.browser.mode`, default `alpine`).                                                                                     |
| `security.csrf`                     | boolean                   | `true`      | Integrated Live requires `true`.                                                                                                                                            |
| `security.requireAuthorizedActions` | boolean                   | `true`      | Integrated Live requires `true`.                                                                                                                                            |

Unknown keys, accessor properties, non-plain objects and wrong types are rejected.

## Diagnostics

Validation collects every problem and throws one `NestvexaConfigError`
(`code: 'INVALID_CONFIGURATION'`) whose `issues` list each `{ path, expected }`:

```text
Invalid Nestvexa configuration at views.cache (expected a boolean); live.client (expected "alpine" or "manual")
```

Supplied values are never echoed, so secrets placed in the wrong key do not reach logs.
`forRoot()` validates synchronously when the module is declared; `forRootAsync()`
validates when Nest resolves the factory, so the application fails before listening.
`NESTVEXA_ERROR_CODES` documents every core error code.

## Precedence: defaults < file < environment < overrides

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  NestvexaModule,
  mergeNestvexaOptions,
  nestvexaOptionsFromEnvironment,
} from 'nestvexa';
import fileOptions from './nestvexa.config.json' with { type: 'json' };

NestvexaModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    mergeNestvexaOptions(
      fileOptions,
      nestvexaOptionsFromEnvironment({
        NESTVEXA_VIEWS_ROOT: config.get('NESTVEXA_VIEWS_ROOT'),
        NESTVEXA_VIEWS_CACHE: config.get('NESTVEXA_VIEWS_CACHE'),
      }),
      { security: { csrf: true } },
    ),
});
```

`mergeNestvexaOptions(...layers)` validates each layer, merges per key with later layers
winning, skips `undefined` layers and validates the result; built-in defaults apply last.
Issues in a layer are reported as `layers[<index>].<path>`.

## Environment variables

`nestvexaOptionsFromEnvironment(record)` maps an explicitly supplied record (for example
`process.env` or values read from a `ConfigService`):

| Variable                                       | Option                              |
| ---------------------------------------------- | ----------------------------------- |
| `NESTVEXA_VIEWS_ENGINE`                        | `views.engine`                      |
| `NESTVEXA_VIEWS_ROOT`                          | `views.root`                        |
| `NESTVEXA_VIEWS_CACHE`                         | `views.cache`                       |
| `NESTVEXA_VIEWS_LAYOUT`                        | `views.layout` (`false` disables)   |
| `NESTVEXA_LIVE_ENABLED`                        | `live.enabled`                      |
| `NESTVEXA_LIVE_CLIENT`                         | `live.client`                       |
| `NESTVEXA_SECURITY_CSRF`                       | `security.csrf`                     |
| `NESTVEXA_SECURITY_REQUIRE_AUTHORIZED_ACTIONS` | `security.requireAuthorizedActions` |

Booleans accept `true`, `false`, `1` and `0` (case-insensitive). Unknown names starting
with `NESTVEXA_VIEWS_`, `NESTVEXA_LIVE_` or `NESTVEXA_SECURITY_` are rejected as typos;
other variables, including other packages' `NESTVEXA_*` names, are ignored.

## Async registration

`CoreModule.forRootAsync()` (and the umbrella's `NestvexaModule.forRootAsync()`) accept
exactly one strategy:

- `useFactory` with `inject` and `imports`;
- `useClass: Factory` — instantiated inside the module, implementing
  `NestvexaOptionsFactory.createNestvexaOptions()`;
- `useExisting: token` — an exported provider of an imported module.

`CoreModule.forRoot(options, { global: true })` (or `global: true` in async options)
makes `NestvexaConfigService` and `FeatureCapabilityRegistry` injectable from feature
modules without re-importing; providers are module-local otherwise.

## Capabilities

`FeatureCapabilityRegistry.register(name, capability)` records adapter facts:
`{ supported: true }`, `{ supported: true, degraded: 'why' }` or
`{ supported: false, reason: 'why' }`. `require(name)` throws `UNSUPPORTED_CAPABILITY`
only for unsupported features; `report()` returns a frozen snapshot for startup logs and
devtools. Capabilities are never guessed from installed packages.

Tests: [core configuration](../../tests/core-config.test.ts), [core](../../tests/core.test.ts),
[umbrella Live](../../tests/umbrella-live.test.ts).
