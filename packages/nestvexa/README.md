# nestvexa

Automatic browser startup can register read-only stream endpoints with
`browser: { streams: { summary: { endpoint: '/reports/summary' } } }` in the Live
registration. The host implements and authorizes each ordinary Nest POST route.
Endpoint paths include any public host prefix. See [text streams](../../docs/guides/text-streams.md)
and [sorting](../../docs/reference/nv-sort.md) for the runnable HBS example,
security boundaries and limitations. Manual browser mode configures its client
directly instead of accepting an unused server stream map.

Default Nestvexa distribution. This alpha integrates Handlebars with normal Nest `@Render` controllers and composes explicit Live registration with a shared renderer, client assets and Alpine CSP startup. Host identity, sessions and authorization remain required. The complete Live feature set and frontend framework adapters are not implemented.

## Installation

Not published. Build and pack locally with `pnpm build && pnpm test:pack`; install all generated tarballs together in a consumer. Future registry commands are `npm install nestvexa`, `pnpm add nestvexa`, or `yarn add nestvexa`, after owner-authorized publication. Peers: Nest common/core 12, reflect-metadata 0.2, RxJS 7; an HTTP platform adapter is host-owned. Tested environment evidence is in [compatibility](../../docs/architecture/upstream-compatibility.md).

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

Other template engines render next to HBS with `await registerViewEngine(app, 'ejs', ejsEngine)` (any adapter with `render` and `renderFile`, such as `@nestvexa/engine-ejs`, `-pug` or `-nunjucks`): `@Render('pages/report.ejs')` uses the adapter, views without that extension keep HBS. Express registers it with `app.engine()`; on Fastify the `reply.view` decorator installed by `configureNestvexa` dispatches by extension. Invalid extensions, `hbs` and duplicate registrations are rejected.

`forRootAsync({ imports, inject, useFactory })` supports Nest provider injection. Defaults are HBS, `src/views`, no layout, no production template cache, and Live disabled. Use `views.cache: true` for immutable deployed templates. Public root exports include `NestvexaModule`, `configureNestvexa`, `HbsEngine`, core/view/Live server contracts, `NestvexaBrowserService`, `NestvexaBrowserOptions`, `NestvexaLiveOptions` and `NestvexaLivePolicies`. Dependencies include core, views, engine-hbs, Live, the browser client, Alpine bridge and `@alpinejs/csp` 3.17.5; no React/Vue/Svelte SPA framework or Redis is required. The core kernel retains its separate dependency boundary.

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

Fastify integration uses a public reply decorator; it rejects an existing `reply.view` owner. Express integration registers the HBS engine and view root. Configure once before starting the server. App-owned normal Nest guard/pipe/interceptor behavior remains intact because no controller invocation is replaced.

Templates are trusted code; interpolation escapes, triple braces do not. The MVC and asset modules install no action endpoint or automatic CSRF middleware. Request filenames never become arbitrary filesystem paths; maps, declarations and package metadata are outside the asset catalog. Content hashes identify cache versions and provide no SRI or authorization guarantee. Preserve third-party license comments in the served Alpine build. Compression/CDN/Vite integration and the complete browser/platform matrix remain outside this slice.

See [security hardening](../../docs/security/hardening.md), [starter](../../examples/starter-hbs/README.md), [third-party notices](THIRD_PARTY_NOTICES.md) and [changelog](../../CHANGELOG.md). Run `pnpm test:integration`, `pnpm test:e2e` and `pnpm test:pack` at repository root; executed outcomes are recorded separately. ESM-only; Node 22.13+/24 targeted, exact observed coverage recorded separately. Maintainer name, repository and bugs URLs are deliberately absent until supplied by the owner.
