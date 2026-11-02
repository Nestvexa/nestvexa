import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';

/** Compile .svelte files with the official compiler inside the esbuild graph. */
const sveltePlugin = {
  name: 'svelte',
  setup(builder) {
    builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const { js } = compile(source, {
        filename: path,
        generate: 'client',
        css: 'injected',
      });
      return {
        contents: js.code,
        loader: 'js',
        resolveDir: new URL('./client/', import.meta.url).pathname.replace(
          /^\/(\w:)/,
          '$1',
        ),
      };
    });
  },
};
const result = await build({
  entryPoints: ['client/islands.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: 'dist/public',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  target: 'es2022',
  metafile: true,
  conditions: ['browser'],
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [sveltePlugin],
  logLevel: 'warning',
});
const outputs = Object.keys(result.metafile.outputs).filter((file) =>
  file.endsWith('.js'),
);
console.log(`Islands client: ${outputs.length} files (${outputs.join(', ')})`);
