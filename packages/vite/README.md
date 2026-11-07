# @nestvexa/vite

Vite integration for NestJS hosts: per-app manifest lookup and `<head>` tags
(entry scripts, CSS, module preloads, CSP nonce), immutable static serving of a
build directory with path-traversal protection, an in-process SSR bundle
renderer, the official Inertia SSR server launcher, a dev-server (middleware
mode, HMR) helper, a per-request CSP nonce middleware and a root view for
`@nestvexa/inertia`. A browser-safe `@nestvexa/vite/pages` entry provides the
page registry the framework adapters use.

Status: `0.1.0-alpha.0`, experimental. Verified with **Vite 8.3.5** (Rolldown)
on Node 22/24, Express and the official Inertia 3.10.0 clients. See the
[Vite guide](../../docs/guides/vite.md) and
[ADR 0024](../../docs/adr/0024-frontend-adapters-and-ssr.md).

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack`
(written to `artifacts/packages`) and install the `.tgz` files together. After
owner-authorized publication the registry syntax will be:

```sh
pnpm add @nestvexa/vite
pnpm add -D vite   # only for development mode
```

(`npm install` and `yarn add` take the same package names.)

Peer dependencies: `vite` `^8` is an **optional** peer, needed only by
`createViteDevServer`. Production (manifest mode) never imports Vite, so it can
be omitted from production installs. Node `^22.13 || ^24`, ESM only.

## Architecture and dependencies

The asset layer between a Vite build and Nest: `@nestvexa/inertia` roots use
`viteInertiaRootView` and the SSR renderers, the `@nestvexa/react`, `/vue` and
`/svelte` adapters depend on it for the page registry and the official SSR
server launcher, `@nestvexa/islands/build` (`islandsVitePlugin`) builds islands
through Vite, and HBS/Live pages print manifest tags with `viteViewHelpers`.
Its only runtime dependency is `@nestvexa/views` (`SafeHtml`). It is optional
and **not** included in the `nestvexa` umbrella.

## Usage

```ts
import {
  ViteAssets,
  cspNonce,
  cspNonceMiddleware,
  moduleSsrRenderer,
  viteInertiaRootView,
  viteStaticMiddleware,
} from '@nestvexa/vite';

const assets = new ViteAssets({
  apps: {
    react: {
      entries: ['client/app.tsx'], // manifest keys (Vite input paths)
      base: '/build/', // the Vite `base`
      manifest: join(root, 'dist/client/.vite/manifest.json'),
    },
  },
});

InertiaModule.forRoot({
  version: () => assets.version('react'), // manifest content hash
  rootView: viteInertiaRootView(assets, { app: 'react' }),
  nonce: (request) => cspNonce(request),
  ssr: { renderer: moduleSsrRenderer(join(root, 'dist/ssr/ssr.js')) },
});

app.use(cspNonceMiddleware());
app.use(
  viteStaticMiddleware({ root: join(root, 'dist/client'), prefix: '/build/' }),
);
```

## Public API

### Manifest and tags

| Export                                                           | Purpose                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new ViteAssets({ apps, mode?, devOrigin? })`                    | Per-app lookup. `production` (default) reads and validates each manifest **at construction** and fails fast if the build is missing; `development` emits `@vite/client` + raw entry URLs (same origin by default, or `devOrigin`). |
| `assets.entry(app)`                                              | `{ scripts, styles, preloads }` public URLs.                                                                                                                                                                                       |
| `assets.tags(app, { nonce? })`                                   | Escaped `<meta property="csp-nonce">`, `<link rel="stylesheet">`, `<link rel="modulepreload">` and `<script type="module">` tags.                                                                                                  |
| `assets.version(app)`                                            | First 16 hex chars of the manifest SHA-256 (use as the Inertia asset version); `dev` in development.                                                                                                                               |
| `assets.apps`, `assets.manifestPath(app)`                        | Introspection.                                                                                                                                                                                                                     |
| `readViteManifest(path)`                                         | Reads (≤ 8 MiB) and validates a manifest; returns `{ path, manifest, hash }`.                                                                                                                                                      |
| `parseViteManifest(json \| object)`                              | Validation: every `file`/`css`/`assets` entry must be a normalized relative path (no `..`, scheme, backslash, query or quote) and every import must exist.                                                                         |
| `resolveEntryAssets(manifest, entries, base?)`                   | Entry scripts, CSS of the entry and its static imports, and static-import preloads. Dynamic imports (code-split pages) are **not** preloaded.                                                                                      |
| `renderAssetTags(assets, { nonce?, crossOrigin? })`              | Tag rendering used by `ViteAssets`.                                                                                                                                                                                                |
| `normalizeBase`, `isSafeOutputPath`, `escapeHtml`, `assertNonce` | Validation helpers. Nonces must be base64/base64url, 8–256 characters.                                                                                                                                                             |

### Static files

`viteStaticMiddleware({ root, prefix = '/', immutable?, sourceMaps = false, maxFiles = 10000, instrumentation? })`
returns a Connect/Express/middie middleware over raw Node objects. It walks
`root` **once at startup** and serves only files in that in-memory index:
request paths are never joined onto the filesystem, so `..`, encoded
separators, backslashes, NUL bytes, drive letters, dot-files (including
`.vite/manifest.json`) and symbolic links can never be served. The optional
`instrumentation` (same structural shape as `@nestvexa/observability`) records
`nestvexa.asset.serve` spans with the content type, bytes, status, cache flags
and whether the file exists, never the path. Hashed files
(`name-HASH8+.ext`) get `Cache-Control: public, max-age=31536000, immutable`;
everything else `no-cache`. It sets `Content-Type`, `Content-Length`,
`X-Content-Type-Options: nosniff` and a weak `ETag` (honours `If-None-Match`),
handles `GET`/`HEAD` only, answers malformed percent-encoding with `400` and
calls `next()` for anything it does not own. Source maps are skipped unless
`sourceMaps: true`. Rebuilding requires a restart (production builds are
immutable).

### SSR

| Export                                                                                                                     | Purpose                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moduleSsrRenderer(file, { exportName?, timeoutMs?, cache? })`                                                             | In-process renderer for a built SSR bundle (absolute path), imported on first use (or `await renderer.load()` at bootstrap). Structurally an `InertiaSsrRenderer`.                                |
| `createSsrRenderer({ load, exportName = 'render', timeoutMs = 5000, cache = true })`                                       | Same over any module loader. Each render receives a **fresh copy** parsed from the serialized page (big-integer markers revived like `@inertiajs/core`). Failed loads are not cached.             |
| `ViteSsrError` (`type`: `component-resolution` \| `render` \| `invalid-response` \| `timeout`)                             | Classified failure; `@nestvexa/inertia` then applies `fallback` or `strict`. Messages never include render output.                                                                                |
| `startOfficialSsrServer(createServer, render, { port = 13714, host = '127.0.0.1', cluster = false, formatErrors = true })` | Starts the official `@inertiajs/*/server` HTTP server (`POST /render`, `GET /health`) for `HttpSsrGateway`. Binds to loopback by default because upstream exposes an unauthenticated `/shutdown`. |
| `isMainModule(import.meta.url)`                                                                                            | True when the SSR bundle is the process entry, so one bundle can export `render` and also serve HTTP when run directly.                                                                           |

### Development

`createViteDevServer({ root, configFile?, hmrServer?, allowInProduction?, loadVite? })`
starts Vite in middleware mode (`appType: 'custom'`) and returns
`{ middlewares, server, ssrRenderer(entry), close() }`. Mount
`app.use(handle.middlewares)` before Nest routes; pass `hmrServer:
app.getHttpServer()` so the HMR WebSocket shares the Nest port.
`ssrRenderer('/client/ssr.tsx')` loads the SSR entry through `ssrLoadModule` on
every render, so SSR output follows edits. Vite is imported lazily with a
non-literal specifier; a missing install throws `ViteUnavailableError` with
remediation, and `NODE_ENV=production` refuses dev mode unless
`allowInProduction: true`.

### CSP and Inertia root view

- `cspNonceMiddleware({ directives?, reportOnly?, bytes = 16 })` generates a
  fresh 128-bit nonce per request, sets the policy header and remembers the
  nonce for `cspNonce(request)` (works with Express requests and Fastify's
  `request.raw`). `defaultCspDirectives(nonce)` is `script-src 'nonce-…'
'strict-dynamic'` (code-split chunks imported by the trusted entry load),
  `style-src 'self' 'nonce-…'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`, `form-action 'self'`.
- `viteInertiaRootView(assets, { app?, lang = 'en', head? })` returns a
  `rootView` for `@nestvexa/inertia` that prints the matching app's tags with
  the request nonce, the SSR head and body. It omits its own `<title>` when the
  SSR head already has one. `app` defaults to the Inertia app key.

- `viteViewHelpers(assets, { name = 'viteTags', app? })` returns a trusted
  view helper for HBS/Live (and EJS/Pug/Nunjucks) pages:
  `{{viteTags "live" nonce=cspNonce}}` prints the same tags as `tags()` as
  `SafeHtml`. Register it with `engine.registerHelpers(...)` before the engine
  initializes. The app name may be omitted when one app is configured (or
  `app` is given); invalid nonces, unknown apps and extra options throw.

### Page registry (`@nestvexa/vite/pages`, browser-safe)

`createPageRegistry(import.meta.glob('./pages/**/*.tsx'), { base: './pages/', extensions? })`
builds `{ names, has(name), load(name) }` from an explicit glob. Component names
from the server are only looked up in a map built from the glob keys; they are
never turned into module paths, so a client cannot load arbitrary modules.
Unknown names reject with `PageNotFoundError`; keys outside `base`, unsafe
names (`[A-Za-z0-9_-]` segments only) and duplicates throw `PageRegistryError`.
Also exports `isPageName` and the shared types `InertiaPageLike`,
`SsrRenderResult`, `SsrRender`, `ProgressOptionsLike`.

## Security and performance

- No request reaches the filesystem; the static index and manifests are built
  once at startup. Manifest output paths are validated before they are printed.
- Tags escape every attribute; nonces are validated. The nonce meta lets Vite's
  preload helper add the nonce to chunks and CSS it injects later.
- In-process SSR runs inside the Nest event loop: a slow render delays other
  requests. The timeout bounds the response, not the render (JavaScript cannot
  abort it). Use the official SSR process plus `HttpSsrGateway` to isolate
  rendering, and keep `mode: 'fallback'` unless SSR is mandatory.
- Run production hosts with `NODE_ENV=production` so externalized framework
  runtimes load their production builds.

## Compatibility

- Vite 8 (`build.rolldownOptions`) is the tested version.
- `viteStaticMiddleware` is tested on Express; Fastify uses it through
  `@fastify/middie` (`request.raw`).
- Examples: [`examples/inertia-react`](../../examples/inertia-react),
  [`examples/inertia-vue`](../../examples/inertia-vue),
  [`examples/inertia-svelte`](../../examples/inertia-svelte),
  [`examples/inertia-mixed`](../../examples/inertia-mixed) (HBS/Live page
  assets through `viteTags`) and
  [`examples/islands-vite`](../../examples/islands-vite) (islands built with
  Vite, production manifest and `--dev` mode).

## Status and limits

Status: **Shipped (alpha)**. Manifest tags, immutable static serving, in-process
and official-server SSR, middleware-mode dev server with HMR, the CSP nonce
middleware and the Inertia and HBS/Live view helpers are implemented and
tested.

- `viteStaticMiddleware` behind Fastify (`@fastify/middie`) is not covered by
  a test.
- In-process SSR shares the Nest event loop and its timeout cannot abort a
  running render (see Security and performance).
- The static index is built once at startup; a rebuild needs a restart.
- Manifests from Vite versions before 8 are not tested.

## Testing

```sh
pnpm --filter @nestvexa/vite test
```

Runs `tests/vite-manifest.test.ts`, `tests/vite-static.test.ts` (raw-socket
traversal corpus, Nest Express host), `tests/vite-ssr.test.ts` (fallback/strict
through `@nestvexa/inertia`), `tests/vite-dev.test.ts` (real Vite middleware
mode and SSR reload) and `tests/vite-builds.test.ts` (source maps, duplicate
modules/runtimes and browser-only code in SSR bundles of the real example
builds, so the examples must be built too); the tests import
`packages/*/dist`, so run `pnpm --filter @nestvexa/vite... build` first. Browser coverage runs separately
through Playwright: `tests/browser/inertia-*.spec.ts` (the mixed host's `/live`
route loads its assets through `viteTags`), `tests/browser/inertia-hmr.spec.ts`
(browser HMR for the React, Vue and Svelte examples in dev mode) and
`tests/browser/islands-vite.spec.ts`.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
