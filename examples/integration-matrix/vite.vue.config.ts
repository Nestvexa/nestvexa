import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Vue root: its own manifest (dist/vue/client/.vite/manifest.json), base and
// SSR bundle. Nothing here can pull in React or Svelte.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/vue/',
  plugins: [vue({ features: { prodHydrationMismatchDetails: true } })],
  build: isSsrBuild
    ? { outDir: 'dist/vue/ssr', emptyOutDir: true, sourcemap: true }
    : {
        outDir: 'dist/vue/client',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rolldownOptions: { input: 'client/vue/app.ts' },
      },
}));
