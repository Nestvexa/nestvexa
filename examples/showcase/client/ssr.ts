/**
 * One Node SSR bundle (`vite build --ssr client/ssr.ts` → dist/ssr/ssr.js):
 * `render` for the Inertia pages (moduleSsrRenderer) and `renderers` for the
 * dashboard island (moduleIslandRenderers).
 */
import { vueIslandRenderer } from '@nestvexa/islands/vue-server';
import { createVueSsrRender } from '@nestvexa/vue/ssr';
import { layout, pages } from './inertia/setup';
import { ThroughputChart } from './islands/throughput-chart.js';

export const render = createVueSsrRender({ pages, layout });

export const renderers = {
  'throughput-chart': vueIslandRenderer(ThroughputChart),
};
