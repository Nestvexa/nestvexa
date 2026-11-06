/**
 * Server bundle (built for Node by build-client.mjs): framework renderers for
 * the islands rendered with `IslandRegistry.renderSsr`. Svelte components are
 * compiled with `generate: 'server'` for this bundle.
 */
import { createActionsClient } from '@nestvexa/actions/client';
import { reactIslandRenderer } from '@nestvexa/islands/react-server';
import { svelteIslandRenderer } from '@nestvexa/islands/svelte-server';
import { vueIslandRenderer } from '@nestvexa/islands/vue-server';
import { createActions } from './generated/actions-client.js';
import Origin from './Origin.svelte';
import { Origin as OriginReact } from './origin-react.js';
import { OriginVue } from './origin-vue.js';
import { Kpi } from './react-kpi.js';
import StatusWidget from './StatusWidget.svelte';
import type { DashboardServices } from './services.js';
import { ActivityFeed } from './vue-feed.js';

// Hooks and stores can be created during render, but nothing is callable.
const services: DashboardServices = {
  actions: createActions(
    createActionsClient({
      fetch: () =>
        Promise.reject(new Error('Actions are not callable during SSR')),
    }),
  ),
};
export const renderers = {
  'react-kpi': reactIslandRenderer(Kpi, { services }),
  'activity-feed': vueIslandRenderer(ActivityFeed, { services }),
  'status-widget': svelteIslandRenderer(StatusWidget, { services }),
  'origin-react': reactIslandRenderer(OriginReact),
  'origin-vue': vueIslandRenderer(OriginVue),
  'origin-svelte': svelteIslandRenderer(Origin),
};
