import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(
  new URL('../packages/client/', import.meta.url),
);
const sources = await readdir(
  new URL('../packages/client/src/', import.meta.url),
);
// Keep public ESM module boundaries and exported names. Declarations are emitted
// by TypeScript first; esbuild only optimizes browser JavaScript, not types.
await build({
  absWorkingDir: directory,
  entryPoints: sources
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/${name}`),
  outdir: 'dist',
  outbase: 'src',
  bundle: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  sourcemap: 'linked',
  sourcesContent: true,
  logLevel: 'warning',
});
// The public runtime is one canonical bundle. Private per-module outputs above
// support implementation tests; they are not published or served to applications.
await build({
  absWorkingDir: directory,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  sourcemap: 'linked',
  sourcesContent: true,
  logLevel: 'warning',
});
