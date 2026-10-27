# Serve the Live client and Alpine assets

`nestvexa/assets` provides explicit Nest routes for the installed Live client, Alpine bridge and Alpine CSP build. It replaces per-file asset controllers without requiring Vite or another frontend build tool for an HBS page. Registering it does not start a browser runtime, register Live components or configure authentication.

The `nestvexa` package declares `@nestvexa/client`, `@nestvexa/alpine` and `@alpinejs/csp` as runtime dependencies. The current CSP dependency is pinned to 3.17.5. Browser code remains behind the explicit asset subpath; the core kernel has no renderer/browser dependency. See the [package graph](../architecture/package-dependency-graph.md).

## Register once

```ts
import { Module } from '@nestjs/common';
import { NestvexaModule } from 'nestvexa';
import { NestvexaAssetsModule } from 'nestvexa/assets';

@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root: 'src/views' } }),
    NestvexaAssetsModule.register(),
  ],
})
export class AppModule {}
```

Keep the usual `await configureNestvexa(app)` call before listening when using the MVC bridge. The assets module can also be registered independently of that bridge. Nest initializes its asset snapshot during `app.init()` or `app.listen()`; package import and `register()` perform no filesystem reads. Missing installed asset files fail initialization. A second registration owner in the same application is rejected, including registrations with different public prefixes. Separate Nest applications have separate snapshots and lifecycles.

`NestvexaModule.forRoot({ live: { enabled: true } })` still rejects the incomplete automatic Live setup. Register `LiveModule` and its identity/authorization policy explicitly as in the [Live counter](../../examples/live-counter/README.md).

## Read the manifest and start the browser runtime

Inject `NestvexaAssetsService` into a controller. `getManifest()` is available after Nest initialization and returns frozen `version`, `files` and `entries` objects:

| Entry                   | Served code                                       |
| ----------------------- | ------------------------------------------------- |
| `entries.live`          | The Live client's `index.js` entry                |
| `entries.alpine`        | The installed Alpine CSP ESM build                |
| `entries.alpineAdapter` | Nestvexa's Alpine bridge                          |
| `files`                 | URLs for every approved module, keyed by filename |

Each URL has the form `/_nestvexa/assets/<sha256>/<filename>`. The full SHA-256 version covers sorted filenames and the exact served UTF-8 content with length boundaries. The snapshot currently contains 15 files: 13 Live modules, the bridge and the CSP build. Relative imports stay under the same versioned URL directory. The service serves its snapshotted strings for the lifetime of that application; editing installed files requires a restart to create a new snapshot.

An application-owned external boot route can use the manifest:

```ts
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { NestvexaAssetsService } from 'nestvexa/assets';

@Controller('assets')
export class BrowserBootController {
  constructor(
    @Inject(NestvexaAssetsService)
    private readonly assets: NestvexaAssetsService,
  ) {}

  @Get('boot.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  boot(): string {
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
import Alpine from ${JSON.stringify(entries.alpine)};
import {installLiveAlpine} from ${JSON.stringify(entries.alpineAdapter)};
const client = createLiveClient();
client.mount();
installLiveAlpine(Alpine, client);
Alpine.start();
window.addEventListener('pagehide', () => client.dispose());`;
  }
}
```

Register this controller in the application module, then load it from the page:

```html
<script type="module" src="/assets/boot.js"></script>
```

The host owns startup order and calls `Alpine.start()` once. Register application-specific `Alpine.data()` definitions before that call. An application that already owns Alpine should integrate with that instance through the [Alpine bridge](../../packages/alpine/README.md); do not load another Alpine build into the same document. The [sample boot route](../../examples/live-counter/src/main.ts) demonstrates host-specific local data and error presentation. Its no-store boot route resolves current versioned imports after restart, avoiding a cached boot script that references an obsolete snapshot.

The example's `pagehide` cleanup is a basic document lifecycle policy. Navigation, back-forward-cache restoration and long-lived host integrations still need their own documented lifecycle handling; this asset service does not implement navigation.

## Prefixes and API versioning

| Option     | Default             | Meaning                                                    |
| ---------- | ------------------- | ---------------------------------------------------------- |
| `path`     | `/_nestvexa/assets` | Nest controller path before the asset version and filename |
| `basePath` | `''`                | Public global/proxy prefix added to generated URLs only    |

Both paths allow bounded ASCII letter/digit/underscore/hyphen segments separated by `/`. `path` requires a leading slash; `basePath` also accepts the empty string. Trailing slashes, dot segments, encoded separators, URLs, query strings and fragments reject configuration. Each nonempty value is limited to 256 characters.

For `app.setGlobalPrefix('app')`, register `NestvexaAssetsModule.register({ basePath: '/app' })`. The module does not set the global prefix. If a reverse proxy exposes an additional prefix, include the actual public composition in `basePath` and configure the proxy's routing accordingly. Account for any host global-prefix exclusions. Keep the host boot-script URL consistent with its own controller and proxy route.

Asset controllers use Nest's public `VERSION_NEUTRAL` contract. They do not gain a URI API segment such as `/v1`, or require header/media-type API version selectors. Ordinary application API routes keep the host's version policy. `basePath` therefore describes the asset endpoint's real public prefix, rather than automatically copying an API version prefix.

Choose a dedicated asset path. Host routes and broad wildcard controllers can still overlap it. Nest 12 offers `routeConflictPolicy` diagnostics at application creation; enable appropriate duplicate/shadow errors for the host's route policy. This module checks its own registration ownership rather than taking over arbitrary application routing.

## Caching, errors and security

Successful approved asset responses use JavaScript UTF-8 content type, `X-Content-Type-Options: nosniff`, a representation ETag and `Cache-Control: public, max-age=31536000, immutable`. Conditional GET/HEAD requests can return 304. These are static application code responses and contain no request props, session tokens or component snapshots. Pages that embed private Live state retain their own no-store policy.

The handler sets a no-store baseline before asset lookup. Unknown versions or filenames produce a 404 without acquiring the successful immutable cache policy. Normal Nest guards, interceptors, filters and middleware remain part of the request pipeline; the host owns their final response/header behavior. Keep public assets free of application middleware that injects private data or cookies into cacheable responses.

Only approved installed modules can be returned. Request values select a map entry and are never passed to filesystem resolution. Source maps, TypeScript declarations, package metadata and arbitrary files are outside the route catalog. The service clears its manifest and bytes at application shutdown; manifest access before readiness or after shutdown rejects as unavailable.

Content hashes provide cache identity. This slice supplies no SRI helper, automatic compression, CDN deployment, Vite manifest, SPA renderer, browser auto-start or complete default Live bootstrap. CSP remains a host response policy; loading the CSP build supports the [Alpine CSP contract](https://alpinejs.dev/advanced/csp) but does not install a CSP header. Preserve upstream license comments when redistributing browser code; see [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Migrate from manual asset routes

1. Add one `NestvexaAssetsModule.register()` import and inject its service into the host boot controller.
2. Replace hardcoded imports such as `./live.js`, `./alpine.js` and `./alpine-adapter.js` with the corresponding manifest entry URLs, serialized with `JSON.stringify()` in generated JavaScript.
3. Remove the per-module `readFile()` controllers once every browser import uses the new namespace. Keep host CSS and application boot routes.
4. Keep the application boot response uncached or otherwise revalidated so it can pick up a new manifest version. Deploy package files atomically and restart the Nest process.
5. Verify prefixes, CSP, actual browser module requests and existing host routes in the deployed topology. Do not depend on old version URLs surviving a process restart; old cached pages need a reload or a deployment strategy that retains their assets.

Run `pnpm build`, `pnpm test:integration`, `pnpm test:e2e` and `pnpm test:pack` for the applicable repository checks. Current executed results and unsupported matrices belong in [implementation status](../implementation/STATUS.md); this guide does not declare those checks passed or accept a complete release gate.
