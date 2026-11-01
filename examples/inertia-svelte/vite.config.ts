import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Client build: hashed, code-split assets plus .vite/manifest.json in
// dist/client (served under /build/ by @nestvexa/vite). SSR build
// (`vite build --ssr client/ssr.ts`): a Node module in dist/ssr that the Nest
// host imports in-process. vite-plugin-svelte bundles Svelte libraries such as
// @inertiajs/svelte (published with the `svelte` condition only) into it.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/',
  plugins: [svelte()],
  build: isSsrBuild
    ? { outDir: 'dist/ssr', emptyOutDir: true, sourcemap: true }
    : {
        outDir: 'dist/client',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rolldownOptions: { input: 'client/app.ts' },
      },
}));
