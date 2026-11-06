# Vite with Nest hosts

`@nestvexa/vite` connects Vite builds to Nest-rendered documents. It is
framework-neutral (the React, Vue and Svelte adapters build on it) and never
imports Vite in production. Verified with Vite **8.3.5**.

## Two modes

| Mode        | Assets                                                                                                                   | SSR                                                                           | Needs Vite installed |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------- |
| production  | `vite build` output; `.vite/manifest.json` read once at startup; hashed files served immutable by `viteStaticMiddleware` | built SSR bundle (`vite build --ssr`) in-process, or the official SSR process | **no**               |
| development | Vite middleware mode inside the Nest HTTP server (`@vite/client`, on-demand transforms, HMR WebSocket on the Nest port)  | `ssrLoadModule` per render (follows edits)                                    | yes (devDependency)  |

Choose explicitly; the examples use a `--dev` flag:

```ts
const dev = process.argv.includes('--dev');
const assets = new ViteAssets({
  mode: dev ? 'development' : 'production',
  apps: {
    react: {
      entries: ['client/app.tsx'],
      base: '/build/',
      manifest: join(root, 'dist/client/.vite/manifest.json'),
    },
  },
});
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.use(cspNonceMiddleware());
if (dev) {
  const vite = await createViteDevServer({
    root,
    hmrServer: app.getHttpServer(),
  });
  devRenderer = vite.ssrRenderer('/client/ssr.tsx');
  app.use(vite.middlewares);
} else {
  app.use(
    viteStaticMiddleware({
      root: join(root, 'dist/client'),
      prefix: '/build/',
    }),
  );
}
```

The alternative "proxy" setup — a separate `vite` dev server on its own port —
works with `devOrigin: 'http://localhost:5173'`, but then the CSP must allow
that origin and `ws:` for HMR. Middleware mode keeps one origin and is what the
examples document.

## Vite configuration

```ts
// vite.config.ts
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/', // must equal ViteAssets `base` and the static `prefix`
  plugins: [react()],
  build: isSsrBuild
    ? { outDir: 'dist/ssr', emptyOutDir: true, sourcemap: true }
    : {
        outDir: 'dist/client',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rolldownOptions: { input: 'client/app.tsx' },
      },
}));
```

Build with `vite build && vite build --ssr client/ssr.tsx`. Several roots use
one config per root with distinct `base`/`outDir` (see
`examples/inertia-mixed`).

### Source maps

`build.sourcemap` is Vite's own option and the examples set it to `true` for
client and SSR builds: every chunk ends with `//# sourceMappingURL=<file>.map`
and the map carries `sourcesContent`. Use `'hidden'` to write maps without the
comment (for upload to an error tracker) or `false` to skip them. Writing maps
does not publish them: `viteStaticMiddleware` serves `.map` files only with
`sourceMaps: true`. `tests/vite-builds.test.ts` checks the React, Vue and
Svelte builds for linked v3 maps on every client and SSR chunk.

### Build hygiene checks

`tests/vite-builds.test.ts` analyses the real example builds through their
source maps: no module is bundled into two chunks, no npm package appears in
two versions, the framework runtime (`react-dom`, `@vue/runtime-core`,
`svelte`) and `@inertiajs/core` are present exactly once, and no other
framework's packages are present. SSR bundles must not import browser-only
specifiers (`react-dom/client`, `@vue/runtime-dom`, `svelte/internal/client`,
`@vitejs/*`, `/@vite/client`) nor inline the adapters' browser entries
(`@nestvexa/{react,vue,svelte}` `client.js`), and they render a page in plain
Node with no `window`/`document` defined before or after.

## Tags, preloads and CSP

`assets.tags(app, { nonce })` prints, in order: `<meta property="csp-nonce">`,
stylesheets (entry and static-import CSS), `<link rel="modulepreload">` for
static imports, and the entry `<script type="module">`. Dynamic imports
(lazily globbed pages) are not preloaded. Vite's preload helper reads the nonce
meta, so chunks/CSS it injects later carry the nonce. The default policy from
`cspNonceMiddleware` uses `script-src 'nonce-…' 'strict-dynamic'`, so chunks
imported by the trusted entry load without listing hashes, and
`style-src 'self' 'nonce-…'` for the Inertia progress bar and Vite's dev styles.
Pass the nonce to Inertia with `nonce: (request) => cspNonce(request)`; the
framework adapters read the meta and forward it to the official clients.

## Server-rendered (HBS/Live) pages

`viteViewHelpers(assets)` returns a trusted `viteTags` helper that prints the
same tags for pages rendered by a template engine, so HBS layouts and Live
pages can load a Vite-built stylesheet and enhancement scripts:

```ts
const assets = new ViteAssets({
  apps: {
    live: {
      entries: ['client/live/app.ts'],
      base: '/build/live/',
      manifest: join(root, 'dist/live/client/.vite/manifest.json'),
    },
  },
});
app.get(HbsEngine).registerHelpers(viteViewHelpers(assets)); // before configureNestvexa
app.use(
  viteStaticMiddleware({ root: 'dist/live/client', prefix: '/build/live/' }),
);
```

```hbs
<head>{{nvScripts nonce=cspNonce}} {{viteTags 'live' nonce=cspNonce}}</head>
```

Pass the request's nonce in the view model (`cspNonce: cspNonce(request)`).
With a single configured app the name may be omitted; `{ app, name }` options
pick a default app and another helper name. EJS, Pug and Nunjucks call it as
`viteTags('live', { nonce })`. Tags come from the manifest read at startup,
never from template data; an invalid nonce, unknown app or extra option throws
instead of printing. `examples/inertia-mixed` serves `/live` this way
(asserted in `tests/browser/inertia-mixed.spec.ts`).

## Islands

Islands can be built through Vite instead of esbuild: `islandsVitePlugin` from
`@nestvexa/islands/build` writes the island manifest and bundle analysis from
the Vite client build, `vite build --ssr` produces the island renderers, and
the loader's own Vite manifest drives `ViteAssets.tags` with the request
nonce. In development the same config runs in middleware mode and island SSR
goes through `ssrLoadModule`. Walkthrough:
[Building islands with Vite](islands.md#building-islands-with-vite); example:
`examples/islands-vite` (`tests/browser/islands-vite.spec.ts`).

## Development mode and HMR per adapter

`tests/browser/inertia-hmr.spec.ts` runs the React, Vue and Svelte Inertia
examples with `--dev` (Vite middleware, HMR WebSocket on the Nest port, SSR via
`ssrLoadModule`). `tests/browser/hmr-fixture.mjs` starts each one from a
disposable copy in `artifacts/hmr-inertia-<framework>` whose Home page is a
probe with local state. For each adapter the spec asserts that the dev SSR
markup and `@vite/client` are served and the page hydrates without errors,
and that rewriting the page source on disk updates the open page without a
full reload (a `window` marker survives) and that the next server render
contains the edit. React Fast Refresh and Vue component HMR keep the page's local
state; Svelte 5 HMR re-creates the edited component, so its `$state` starts over
(asserted, so a change in that behaviour is noticed).

## Client-only mode

Omitting the `ssr` option of an Inertia app serves the page script and an
empty root (`<div id="app"></div>`); the adapters' mount helpers then mount
instead of hydrating. Each adapter example has `pnpm start:csr` for this mode,
with a browser test for mounting, navigation and validation.

## Static serving

`viteStaticMiddleware` indexes the build directory at startup and serves only
indexed regular files: request paths are never joined to the filesystem, so
traversal, encoded separators, dot-files (the manifest) and symlinks are
impossible to reach. Hashed files are cached for a year (`immutable`), others
revalidate. Source maps are not served unless `sourceMaps: true` (they are still
written by the build for error reporting and upstream SSR stack mapping).

## Versioning

`assets.version(app)` is a hash of the manifest bytes. Pass it as the Inertia
`version`; any rebuild changes it, and the official client then performs a full
reload on its next visit (409 + `X-Inertia-Location`).

## Vite unavailable in production

Production code paths import neither `vite` nor any plugin; `vite` is an
optional peer. `createViteDevServer` imports it lazily and throws
`ViteUnavailableError` ("requires the optional peer dependency `vite`…") when it
is missing, and refuses to run with `NODE_ENV=production` unless
`allowInProduction` is set. A missing build fails at startup with
`Vite manifest not found at …; run \`vite build\``.

## Measured build cost (this repository, Windows, shared CI-class host)

Client + SSR build per example: roughly 3–5 s for React/Vue, 2–4 s for Svelte
(Vite's own timings); the mixed example runs six builds. Initial client
bundles, gzip: React 112 KB, Vue 69 KB, Svelte 56 KB (framework + official
Inertia client); pages are separate 0.1–0.8 KB chunks. These are observations,
not budgets.
