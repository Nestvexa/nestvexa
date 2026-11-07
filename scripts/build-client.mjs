import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(
  new URL('../packages/client/', import.meta.url),
);
const sources = await readdir(
  new URL('../packages/client/src/', import.meta.url),
);
/**
 * Optional features served as separate on-demand chunks (ADR 0035). The entry
 * imports each one dynamically by a fixed sibling name; the asset catalog
 * version, not the file name, makes the URL content-addressed.
 */
export const CLIENT_CHUNKS = Object.freeze({
  sort: 'live-sort.js',
  stream: 'live-stream.js',
  upload: 'live-upload.js',
  realtime: 'live-realtime.js',
});
const shared = {
  absWorkingDir: directory,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  sourcemap: 'linked',
  sourcesContent: true,
  logLevel: 'warning',
};
// Keep public ESM module boundaries and exported names. Declarations are emitted
// by TypeScript first; esbuild only optimizes browser JavaScript, not types.
await build({
  ...shared,
  entryPoints: sources
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/${name}`),
  outdir: 'dist',
  outbase: 'src',
  bundle: false,
});
// The public runtime is one canonical entry plus the optional chunks below.
// Private per-module outputs above support implementation tests; they are not
// published or served to applications.
await build({
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  plugins: [
    {
      name: 'nestvexa-feature-chunks',
      setup(context) {
        // Only the dynamic `import('./<feature>.js')` becomes a chunk request;
        // static imports of the same module bundle just their used exports.
        context.onResolve({ filter: /^\.\/[a-z]+\.js$/ }, (args) => {
          if (args.kind !== 'dynamic-import') return undefined;
          const chunk = CLIENT_CHUNKS[args.path.slice(2, -3)];
          if (!chunk) throw new Error(`Unexpected dynamic import ${args.path}`);
          return { path: `./${chunk}`, external: true };
        });
      },
    },
  ],
});
// Each chunk imports the shared error class and identifier grammar from the
// entry (the same module instance on the page), never a private copy.
for (const [feature, chunk] of Object.entries(CLIENT_CHUNKS))
  await build({
    ...shared,
    entryPoints: [`src/${feature}.ts`],
    outfile: `dist/${chunk}`,
    bundle: true,
    plugins: [
      {
        name: 'nestvexa-chunk-entry',
        setup(context) {
          context.onResolve({ filter: /^\.\// }, (args) => {
            if (args.kind === 'entry-point') return undefined;
            if (args.path === './grammar.js')
              return { path: './index.js', external: true };
            throw new Error(
              `Chunk ${chunk} may import only ./grammar.js, not ${args.path}`,
            );
          });
        },
      },
    ],
  });
