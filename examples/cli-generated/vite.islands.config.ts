import vue from '@vitejs/plugin-vue';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/** Framework plugins of the islands bundle. `nestvexa make:island` appends here. */
const plugins: PluginOption[] = [
  react(),
  vue(),
  svelte(),
  // nestvexa:island-plugins
];

// One code-split bundle: dist/islands/islands.js loads each framework chunk on demand.
export default defineConfig({
  base: '/islands/',
  plugins,
  build: {
    outDir: 'dist/islands',
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: {
      input: 'client/islands/index.ts',
      output: {
        entryFileNames: 'islands.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
