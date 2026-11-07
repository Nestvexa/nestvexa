import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Two builds from one config:
//  - `vite build`: browser entries (the Inertia app and the islands loader)
//    with one manifest (dist/client/.vite/manifest.json) read by ViteAssets;
//  - `vite build --ssr client/ssr.ts`: dist/ssr/ssr.js with the Inertia
//    `render` and the island `renderers`.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/',
  plugins: [vue()],
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: isSsrBuild
    ? { outDir: 'dist/ssr', emptyOutDir: true }
    : {
        outDir: 'dist/client',
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: {
          input: ['client/inertia/app.ts', 'client/islands/loader.ts'],
        },
      },
}));
