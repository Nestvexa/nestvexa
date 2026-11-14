/**
 * One Node SSR bundle (`vite build --ssr client/ssr.ts` → dist/ssr/ssr.js):
 * `render` for the Inertia pages (moduleSsrRenderer) and `renderers` for the
 * dashboard islands (moduleIslandRenderers): Vue, React and Svelte.
 */
import { reactIslandRenderer } from '@nestvexa/islands/react-server';
import { svelteIslandRenderer } from '@nestvexa/islands/svelte-server';
import { vueIslandRenderer } from '@nestvexa/islands/vue-server';
import { createVueSsrRender } from '@nestvexa/vue/ssr';
import { layout, pages } from './inertia/setup';
import { MemberChart } from './islands/member-chart.js';
import PulseWidget from './islands/PulseWidget.svelte';
import { ThroughputChart } from './islands/throughput-chart.js';

export const render = createVueSsrRender({ pages, layout });

export const renderers = {
  'throughput-chart': vueIslandRenderer(ThroughputChart),
  'member-chart': reactIslandRenderer(MemberChart),
  'pulse-widget': svelteIslandRenderer(PulseWidget),
};
