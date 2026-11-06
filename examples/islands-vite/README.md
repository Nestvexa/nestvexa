# Islands built through Vite

React, Vue and Svelte islands on a Nest-rendered page, built and served with
Vite and `@nestvexa/vite` instead of the esbuild script used by
[hybrid-dashboard](../hybrid-dashboard). Same island contract: one manifest is
the server registry and the browser allowlist.

```sh
pnpm --filter @nestvexa/example-islands-vite build
pnpm --filter @nestvexa/example-islands-vite start   # http://127.0.0.1:3479 (PORT)
pnpm --filter @nestvexa/example-islands-vite dev     # Vite middleware + HMR on the same port
```

Build steps (`package.json`):

1. `vite build -c vite.islands.config.ts`: every island entry
   (`src/island-definitions.ts`) is a Vite input; `islandsVitePlugin` writes
   `dist/islands/.vite/islands-manifest.json`, `islands-analysis.json` and
   `islands-metafile.json` (never served) and fails on a foreign framework
   runtime or a budget overrun.
2. `vite build -c vite.islands.config.ts --ssr client/ssr.ts`: `dist/ssr/ssr.js`
   exports the island `renderers`; the server loads it with
   `moduleIslandRenderers`.
3. `vite build -c vite.loader.config.ts`: the loader (`client/loader.ts`)
   bundles the generated manifest and loads each island only from its
   manifest bundle path; `ViteAssets` prints its tags with the request's CSP
   nonce (`cspNonceMiddleware`, `'strict-dynamic'`).

`--dev` runs `createViteDevServer` with `vite.islands.config.ts`, the HMR
socket on the Nest server, island SSR through `ssrLoadModule` on every render
and `client/loader.dev.ts` (a static allowlist of dynamic imports).

Tested by `tests/islands-vite.test.ts` and `tests/browser/islands-vite.spec.ts`.
