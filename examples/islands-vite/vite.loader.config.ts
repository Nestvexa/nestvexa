import { defineConfig } from 'vite';

// The loader is a separate, later build: it bundles the island manifest the
// islands build wrote. Its own .vite/manifest.json drives the nonce'd
// <script> tags printed by ViteAssets (served under /build/).
export default defineConfig({
  base: '/build/',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: { input: 'client/loader.ts' },
  },
});
