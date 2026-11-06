---
'@nestvexa/islands': minor
---

Build islands through Vite: `islandsVitePlugin` (from `@nestvexa/islands/build`)
records an esbuild-style metafile of the Vite client build, keeps island entry
mount exports, and writes the island manifest and bundle analysis into
`<outDir>/.vite/`, failing the build on a foreign framework runtime, a budget
overrun or a lost default export. `createViteIslandManifest` maps a Vite build
manifest to island bundle paths, and `moduleIslandRenderers` serves island SSR
from a `vite build --ssr` bundle or Vite's `ssrLoadModule` in development.
