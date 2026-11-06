/**
 * SSR entry built by `vite build --ssr client/ssr.ts` (dist/ssr/ssr.js) and
 * loaded through Vite's `ssrLoadModule` in development. The server wraps it
 * with `moduleIslandRenderers`, so only the `renderers` export is read.
 */
import { reactIslandRenderer } from '@nestvexa/islands/react-server';
import { svelteIslandRenderer } from '@nestvexa/islands/svelte-server';
import { vueIslandRenderer } from '@nestvexa/islands/vue-server';
import { CounterReact } from './islands/counter-react.js';
import { CounterVue } from './islands/counter-vue.js';
import Counter from './islands/Counter.svelte';

export const renderers = {
  'counter-react': reactIslandRenderer(CounterReact),
  'counter-vue': vueIslandRenderer(CounterVue),
  'counter-svelte': svelteIslandRenderer(Counter),
};
