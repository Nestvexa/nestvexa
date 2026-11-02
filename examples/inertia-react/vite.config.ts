import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Client build: hashed, code-split assets plus .vite/manifest.json in
// dist/client (served under /build/ by @nestvexa/vite). SSR build
// (`vite build --ssr client/ssr.tsx`): a Node module in dist/ssr.
export default defineConfig(({ isSsrBuild }) => ({
  base: '/build/',
  plugins: [react()],
  build: isSsrBuild
    ? { outDir: 'dist/ssr', emptyOutDir: true, sourcemap: true }
    : {
        outDir: 'dist/client',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rolldownOptions: { input: 'client/app.tsx' },
      },
}));
