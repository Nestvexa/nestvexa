# nestvexa

Default Nestvexa distribution. This alpha integrates Handlebars with normal Nest `@Render` controllers and provides an explicit `nestvexa/assets` module for serving the Live browser client and Alpine CSP build. Live server registration and browser startup remain host-owned; the automatic full Live bootstrap and frontend framework adapters are not implemented.

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

`forRootAsync({ imports, inject, useFactory })` supports Nest provider injection. Defaults are HBS, `src/views`, no layout, no production template cache, and Live disabled. Use `views.cache: true` for immutable deployed templates. Public root exports include `NestvexaModule`, `configureNestvexa`, `HbsEngine` and core/view contracts. Dependencies include core, views, engine-hbs, the browser client, Alpine bridge and `@alpinejs/csp` 3.17.5; no React/Vue/Svelte SPA framework or Redis is required. The core kernel retains its separate dependency boundary.

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

The service snapshots 15 approved installed modules during Nest initialization and exposes frozen URLs under a full content hash. `getManifest()` rejects before readiness or after shutdown; `read(version, name)` returns an approved immutable representation or rejects an unknown version/file. Successful asset responses have JavaScript MIME, nosniff, ETag/conditional request handling and immutable public caching. Lookup failures keep the handler's no-store baseline. Normal host middleware/interceptors/filters retain final response policy.

Serve an application-owned external boot script that imports those manifest URLs, registers local Alpine data and starts its chosen client/Alpine instances once. The [client asset guide](../../docs/guides/client-assets.md) includes complete setup and migration from per-file controllers. The module does not start Alpine, install CSP/session/CSRF middleware, register actions or enable `live.enabled: true`; the latter still rejects the incomplete automatic bootstrap. Use the separate Live module and its explicit security policy as demonstrated by the [counter](../../examples/live-counter/README.md).

Fastify integration uses a public reply decorator; it rejects an existing `reply.view` owner. Express integration registers the HBS engine and view root. Configure once before starting the server. App-owned normal Nest guard/pipe/interceptor behavior remains intact because no controller invocation is replaced.

Templates are trusted code; interpolation escapes, triple braces do not. The MVC and asset modules install no action endpoint or automatic CSRF middleware. Request filenames never become arbitrary filesystem paths; maps, declarations and package metadata are outside the asset catalog. Content hashes identify cache versions and provide no SRI or authorization guarantee. Preserve third-party license comments in the served Alpine build. Compression/CDN/Vite integration and the complete browser/platform matrix remain outside this slice.

See [security hardening](../../docs/security/hardening.md), [starter](../../examples/starter-hbs/README.md), [third-party notices](THIRD_PARTY_NOTICES.md) and [changelog](../../CHANGELOG.md). Run `pnpm test:integration`, `pnpm test:e2e` and `pnpm test:pack` at repository root; executed outcomes are recorded separately. ESM-only; Node 22.13+/24 targeted, exact observed coverage recorded separately. Maintainer name, repository and bugs URLs are deliberately absent until supplied by the owner.
