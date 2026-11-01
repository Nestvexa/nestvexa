// Bundles the official @inertiajs/react client page for the browser tests.
// React/Vite SSR is Phase 9; this is a plain client-side esbuild bundle.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./client/app.tsx', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/public/app.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
console.log('Built examples/inertia-basic/dist/public/app.js');
