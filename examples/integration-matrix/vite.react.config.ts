import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// React root: its own manifest (dist/react/client/.vite/manifest.json), base
// and SSR bundle. Nothing here can pull in Vue or Svelte.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/react/',
  plugins: [react()],
  build: isSsrBuild
    ? { outDir: 'dist/react/ssr', emptyOutDir: true, sourcemap: true }
    : {
        outDir: 'dist/react/client',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rolldownOptions: { input: 'client/react/app.tsx' },
      },
}));
