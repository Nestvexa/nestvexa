import '@vitejs/plugin-react/preamble';
import { createIslands } from '@nestvexa/islands/client';
import { hooks, start } from './observe.js';

/**
 * Development loader served by the Vite dev middleware: there is no build
 * manifest yet, so the allowlist is this static map of bundler-resolved
 * dynamic imports (source modules with HMR). Props schemas are still checked
 * by the server registry before markup is rendered.
 */
start(
  createIslands({
    modules: {
      'counter-react': async () =>
        (await import('./islands/counter-react.js')).default,
      'counter-vue': async () =>
        (await import('./islands/counter-vue.js')).default,
      'counter-svelte': async () =>
        (await import('./islands/counter-svelte.js')).default,
    },
    ...hooks,
  }),
);
