// Three esbuild passes:
//  1. island entries (one chunk graph per island, code-split, content-hashed)
//     -> island manifest + bundle analysis from the metafile;
//  2. the loader, which bundles that manifest as its allowlist;
//  3. a Node bundle with the server renderers used for SSR.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import {
  analyzeIslandBundles,
  createIslandManifest,
} from '@nestvexa/islands/build';

const clientDirectory = new URL('./client/', import.meta.url).pathname.replace(
  /^\/(\w:)/,
  '$1',
);
/** Compile .svelte files with the official compiler inside the esbuild graph. */
const sveltePlugin = (generate) => ({
  name: 'svelte',
  setup(builder) {
    builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const { js } = compile(source, {
        filename: path,
        generate,
        css: 'injected',
      });
      return { contents: js.code, loader: 'js', resolveDir: clientDirectory };
    });
  },
});
const define = {
  'process.env.NODE_ENV': '"production"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};
const objectProps = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});
// Island definitions: the single source for the manifest (server registry
// and browser allowlist). Budgets are gzip bytes for each island's chunks.
const definitions = [
  {
    id: 'revenue-chart',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/react-chart.tsx',
    budgetBytes: 80_000,
    props: objectProps({
      title: { type: 'string', maxLength: 80 },
      values: { type: 'array', maxItems: 12, items: { type: 'number' } },
    }),
  },
  {
    id: 'react-kpi',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/react-kpi.tsx',
    budgetBytes: 80_000,
    props: objectProps({
      label: { type: 'string', maxLength: 40 },
      value: { type: 'integer' },
    }),
  },
  {
    id: 'activity-feed',
    framework: 'vue',
    strategy: 'visible',
    entry: 'client/vue-feed.ts',
    budgetBytes: 45_000,
    props: objectProps({
      items: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', maxLength: 120 },
      },
    }),
  },
  {
    id: 'status-widget',
    framework: 'svelte',
    strategy: 'idle',
    entry: 'client/svelte-widget.ts',
    budgetBytes: 30_000,
    signed: true,
    props: objectProps({
      label: { type: 'string', maxLength: 40 },
      workspace: { type: 'string', maxLength: 40 },
    }),
  },
  {
    id: 'broken-island',
    framework: 'custom',
    strategy: 'immediate',
    entry: 'client/broken.ts',
    budgetBytes: 2_000,
  },
  {
    id: 'origin-react',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/origin-react.tsx',
  },
  {
    id: 'origin-vue',
    framework: 'vue',
    strategy: 'immediate',
    entry: 'client/origin-vue.ts',
  },
  {
    id: 'origin-svelte',
    framework: 'svelte',
    strategy: 'immediate',
    entry: 'client/origin-svelte.ts',
  },
];
const islandsDirectory = 'dist/public/islands';
const islands = await build({
  entryPoints: definitions.map((definition) => definition.entry),
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: islandsDirectory,
  outbase: 'client',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  target: 'es2022',
  metafile: true,
  conditions: ['browser'],
  define,
  plugins: [sveltePlugin('client')],
  logLevel: 'warning',
});
const options = { outdir: islandsDirectory, publicPath: '/islands/' };
const manifest = createIslandManifest(definitions, islands.metafile, options);
const analysis = analyzeIslandBundles(manifest, islands.metafile, options);
await mkdir('client/generated', { recursive: true });
await writeFile(
  'client/generated/islands-manifest.json',
  JSON.stringify(manifest, null, 2),
);
await writeFile(
  'dist/public/islands-manifest.json',
  JSON.stringify(manifest, null, 2),
);
await writeFile(
  'dist/public/islands-analysis.json',
  JSON.stringify(analysis, null, 2),
);
// Raw metafile for scripts/islands-size.mjs and external bundle analyzers.
await writeFile(
  'dist/public/islands-metafile.json',
  JSON.stringify(islands.metafile),
);

await build({
  entryPoints: ['client/islands.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/public/islands-loader.js',
  minify: true,
  target: 'es2022',
  conditions: ['browser'],
  logLevel: 'warning',
});

await build({
  entryPoints: ['client/ssr.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/ssr/islands-ssr.js',
  // CommonJS dependencies (react-dom/server) require Node built-ins.
  banner: {
    js: "import { createRequire as nvCreateRequire } from 'node:module'; const require = nvCreateRequire(import.meta.url);",
  },
  jsx: 'automatic',
  target: 'node22',
  define,
  plugins: [sveltePlugin('server')],
  logLevel: 'warning',
});

for (const island of analysis.islands)
  console.log(
    `island ${island.id} (${island.framework}): ${island.gzipBytes} gzip bytes` +
      `${island.budgetBytes ? ` / budget ${island.budgetBytes}` : ''} across ${island.chunks.length} chunk(s)`,
  );
for (const [framework, files] of Object.entries(analysis.frameworks))
  console.log(`${framework} runtime chunks: ${files.join(', ')}`);
if (analysis.violations.length > 0) {
  for (const violation of analysis.violations)
    console.error(`island bundle violation: ${violation}`);
  process.exitCode = 1;
}
