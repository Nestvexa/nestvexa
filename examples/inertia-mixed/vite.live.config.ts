import { defineConfig } from 'vite';

// Assets of the HBS/Live page: plain TypeScript + CSS, no framework. Two
// entries share a module, so the manifest carries CSS, an entry and a shared
// chunk that `viteTags "live"` prints as a modulepreload.
export default defineConfig({
  base: '/build/live/',
  build: {
    outDir: 'dist/live/client',
    emptyOutDir: true,
    manifest: true,
    sourcemap: true,
    rolldownOptions: {
      input: ['client/live/app.ts', 'client/live/widgets.ts'],
    },
  },
});
