import { islandsVitePlugin } from '@nestvexa/islands/build';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { islandDefinitions } from './src/island-definitions.js';

// Islands through Vite instead of esbuild:
//  - `vite build -c vite.islands.config.ts`: every island entry is an input
//    (code-split, content-hashed, one shared chunk per framework runtime);
//    islandsVitePlugin writes dist/islands/.vite/islands-manifest.json, the bundle
//    analysis and an esbuild-style metafile, and fails on violations;
//  - `... --ssr client/ssr.ts`: the Node SSR bundle in dist/ssr;
//  - development: the same config drives the Vite dev middleware (HMR on the
//    Nest HTTP server, SSR through ssrLoadModule).
export default defineConfig(({ isSsrBuild }) => ({
  base: '/islands/',
  plugins: [
    react(),
    svelte(),
    islandsVitePlugin({ islands: islandDefinitions }),
  ],
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: isSsrBuild
    ? { outDir: 'dist/ssr', emptyOutDir: true }
    : {
        outDir: 'dist/islands',
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: {
          input: islandDefinitions.map((island) => island.entry),
        },
      },
}));
