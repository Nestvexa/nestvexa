import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Svelte root: its own manifest (dist/svelte/client/.vite/manifest.json), base
// and SSR bundle. Nothing here can pull in React or Vue.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/svelte/',
  plugins: [svelte()],
  build: isSsrBuild
    ? { outDir: 'dist/svelte/ssr', emptyOutDir: true, sourcemap: true }
    : {
        outDir: 'dist/svelte/client',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rolldownOptions: { input: 'client/svelte/app.ts' },
      },
}));
