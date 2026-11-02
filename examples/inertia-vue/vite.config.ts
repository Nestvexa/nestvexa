import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Client build: hashed, code-split assets plus .vite/manifest.json in
// dist/client (served under /build/ by @nestvexa/vite). SSR build
// (`vite build --ssr client/ssr.ts`): a Node module in dist/ssr that the Nest
// host imports in-process.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/',
  // Production builds keep hydration mismatch details so the browser tests
  // would see (and fail on) any server/client disagreement.
  plugins: [vue({ features: { prodHydrationMismatchDetails: true } })],
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
