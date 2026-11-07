# nestvexa

Default Nestvexa distribution. This alpha integrates Handlebars with normal Nest `@Render` controllers and composes explicit Live registration with a shared renderer, client assets and Alpine CSP startup. Host identity, sessions and authorization remain required. React/Vue/Svelte pages (Inertia), islands, realtime, uploads, forms and the other optional packages are installed separately; see [Dependencies](#dependencies).

## Installation

Not published yet. Build and pack locally with `pnpm build && pnpm test:pack`; install all generated tarballs together in a consumer. Future registry commands are `npm install nestvexa`, `pnpm add nestvexa`, or `yarn add nestvexa`, after owner-authorized publication. Peers: Nest common/core 12, reflect-metadata 0.2, RxJS 7; an HTTP platform adapter (Express or Fastify) is host-owned. `@nestvexa/cli` is an optional peer used by the `nestvexa` bin. ESM only; Node 22.13+ or 24. Tested environment evidence is in [compatibility](../../docs/architecture/upstream-compatibility.md).

## Usage

```ts
import { NestvexaModule, configureNestvexa } from 'nestvexa';
// In @Module imports:
NestvexaModule.forRoot({
  views: { root: 'src/views', layout: 'layouts/main' },
});
// After NestFactory.create, before listen:
await configureNestvexa(app);
```

Other template engines render next to HBS with `await registerViewEngine(app, 'ejs', ejsEngine)` (any adapter with `render` and `renderFile`, such as `@nestvexa/engine-ejs`, `-pug` or `-nunjucks`): `@Render('pages/report.ejs')` uses the adapter, views without that extension keep HBS. Express registers it with `app.engine()`; on Fastify the `reply.view` decorator installed by `configureNestvexa` dispatches by extension. Invalid extensions, `hbs` and duplicate registrations are rejected. See [template engines](../../docs/guides/template-engines.md).

## Public API and defaults

`forRootAsync({ imports, inject, useFactory })` supports Nest provider injection. An optional third `forRoot` argument passes kernel services (request context, diagnostics, extensions, error logging) to `CoreModule`; see the [core README](../core/README.md#kernel-services). Defaults are HBS, `src/views`, no layout, no production template cache, and Live disabled. Use `views.cache: true` for immutable deployed templates.

Public root exports include `NestvexaModule`, `configureNestvexa`, `registerViewEngine`, `HbsEngine`, everything exported by `@nestvexa/core`, `@nestvexa/views` and `@nestvexa/live` (decorators such as `@LiveComponent`, `@State` and `@Action`, and their types), `NestvexaBrowserService`, `NestvexaBrowserOptions`, `NestvexaLiveOptions` and `NestvexaLivePolicies`. The `nestvexa/assets` subpath is described [below](#explicit-browser-asset-hosting). The `nestvexa` bin delegates to the optional `@nestvexa/cli` and prints an install hint when it is absent.

## Dependencies

Dependencies include core, views, engine-hbs, Live, the browser client, Alpine bridge and `@alpinejs/csp` 3.17.5; no React/Vue/Svelte SPA framework or Redis is required. The core kernel retains its separate dependency boundary. Optional packages are added next to the umbrella when needed: `@nestvexa/realtime` and `@nestvexa/realtime-redis`, `@nestvexa/inertia` with `@nestvexa/react`, `-vue` or `-svelte`, `@nestvexa/islands`, `@nestvexa/vite`, `@nestvexa/forms`, `@nestvexa/actions`, `@nestvexa/uploads`, `@nestvexa/offline`, `@nestvexa/ui`, `@nestvexa/mail`, `@nestvexa/observability` and the extra template engines.

## Integrated Live setup

```ts
NestvexaModule.forRoot(
  { views: { root: 'src/views', layout: 'layout' }, live: { enabled: true } },
  {
    components: [Counter],
    useFactory: () => ({ origin, resolveIdentity, authorize }),
  },
);
```

The component and policies are host-owned; see the complete [starter](../../examples/starter-live/src/main.ts) and [setup guide](../../docs/guides/default-live-setup.md). The registration accepts static components, endpoint/basePath, imports/inject, browser options and a sync/async policy factory. The factory cannot override the shared renderer or route structure. `forRootAsync` accepts the same second argument. Request-scoped configuration is rejected; components retain request-scoped DI. Both security flags must remain enabled.

Put `{{nvScripts}}` or `{{nvScripts nonce=cspNonce}}` in the document layout. `NestvexaBrowserService.scripts(nonce?)` exposes the same trusted tag; `getBootUrl()` resolves the neutral boot route and `boot()` returns its generated module. Initialization/shutdown are application-local. `browser.mode: 'manual'` removes the boot route and rejects script generation while retaining installed asset hosting. `browser.path`, `assetsPath` and `basePath` configure public paths; URI-versioned Live routes may need a separate browser basePath because boot/assets remain version-neutral. Manual startup is required for existing host Alpine.

Automatic browser startup can register read-only stream endpoints with `browser: { streams: { summary: { endpoint: '/reports/summary' } } }` in the Live registration. The host implements and authorizes each ordinary Nest POST route. Endpoint paths include any public host prefix. See [text streams](../../docs/guides/text-streams.md) and [sorting](../../docs/reference/nv-sort.md) for the runnable HBS example, security boundaries and limitations. Manual browser mode configures its client directly instead of accepting an unused server stream map. `browser.realtime` passes the realtime endpoint and transport to the boot module when `@nestvexa/realtime` is installed ([realtime](../realtime/README.md)).

## Explicit browser asset hosting

```ts
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';

// Add once to @Module imports:
NestvexaAssetsModule.register();
// After app.init() or app.listen(), or by injecting the service in a controller:
const { entries } = app.get(NestvexaAssetsService).getManifest();
// entries.live, entries.alpine and entries.alpineAdapter are versioned URLs.
```

The subpath exports the module, service and `NestvexaAssetOptions`, `ClientAssetManifest` and `ClientAsset` types. `register({ path, basePath })` defaults to `/_nestvexa/assets` and an empty public prefix. For a global prefix `app`, use `basePath: '/app'`; it changes generated URLs, not host routing. Assets are version-neutral under Nest API versioning. Register exactly one owner per application.

The service snapshots three approved installed assets (the bundled Live entry, Alpine and its adapter) during Nest initialization and exposes frozen URLs under a full content hash. `getManifest()` rejects before readiness or after shutdown; `read(version, name)` returns an approved immutable representation or rejects an unknown version/file. Successful asset responses have JavaScript MIME, nosniff, ETag/conditional request handling and immutable public caching. Lookup failures keep the handler's no-store baseline. Normal host middleware/interceptors/filters retain final response policy. The client module list includes `focus.js`; custom hosts maintaining file allowlists must add it when upgrading.

For standalone asset registration, serve an application-owned external boot script importing those URLs and starting its chosen pair once. The [client asset guide](../../docs/guides/client-assets.md) includes lower-level setup and migration from per-file controllers. This standalone subpath does not start Alpine or register actions. Integrated Live already registers assets; do not register a competing asset owner. Neither mode installs host CSP/session/authentication middleware.

## Platform integration

Fastify integration uses a public reply decorator; it rejects an existing `reply.view` owner. Express integration registers the HBS engine and view root. Configure once before starting the server. App-owned normal Nest guard/pipe/interceptor behavior remains intact because no controller invocation is replaced.

## Security and performance

Templates are trusted code; interpolation escapes, triple braces do not. The MVC and asset modules install no action endpoint or automatic CSRF middleware. Request filenames never become arbitrary filesystem paths; maps, declarations and package metadata are outside the asset catalog. Content hashes identify cache versions and provide no SRI or authorization guarantee. Preserve third-party license comments in the served Alpine build. See [security hardening](../../docs/security/hardening.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Examples

[starter-hbs](../../examples/starter-hbs/README.md) (MVC), [starter-live](../../examples/starter-live/README.md) (integrated Live), [starter-ejs](../../examples/starter-ejs/README.md) (EJS adapter), and the [express-host](../../examples/express-host/README.md) and [fastify-host](../../examples/fastify-host/README.md) adapters. Start with the [getting started guide](../../docs/getting-started/README.md).

## Status and limits

Status: **Shipped (alpha)**. MVC rendering, extra view engines on Express and Fastify, integrated Live registration with browser boot and the `nestvexa/assets` asset host are implemented and tested; there is no stability promise.

- No SRI, compression or CDN publishing for served assets (CORE-045); Vite builds are the job of the optional `@nestvexa/vite`.
- The `nestvexa` bin wrapper has no dedicated test; the CLI it delegates to is tested in `@nestvexa/cli`.
- Hosts that already run their own Alpine need manual browser startup, and URI-versioned Live routes may need a separate browser `basePath`.
- Identity, sessions, CSP and authorization stay host-owned; the umbrella installs none of them.

## Testing

```sh
pnpm --filter nestvexa test
```

Runs `tests/integration.test.ts`, `tests/assets.test.ts` and `tests/umbrella-*.test.ts` (Live registration, view engines) with the root Vitest config; the tests import `packages/*/dist`, so run `pnpm --filter nestvexa... build` first. Browser specs such as `tests/browser/mvc.spec.ts`, `default-setup.spec.ts` and `assets.spec.ts` run separately with `pnpm test:e2e`, and `pnpm test:pack` checks packed consumers.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
