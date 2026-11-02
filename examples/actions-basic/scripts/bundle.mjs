// Bundles the typed browser script (and the browser-safe actions client) into
// one same-origin ES module served under a strict script-src 'self' CSP.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [`${root}browser/main.ts`],
  outfile: `${root}dist/public/app.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
});
