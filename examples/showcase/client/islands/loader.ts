import { createIslands } from '@nestvexa/islands/client';

/**
 * Islands loader for the HBS pages. The allowlist is this build-time map of
 * bundler-resolved imports: markup can only name an id listed here, and the
 * module URL never comes from the page. Each island is a lazy chunk, so the
 * React runtime loads only for the React chart and Svelte only for the
 * widget.
 */
const loader = createIslands({
  modules: {
    'throughput-chart': () =>
      import('./throughput-chart.js').then((module) => module.default),
    'member-chart': () =>
      import('./member-chart.js').then((module) => module.default),
    'pulse-widget': () =>
      import('./pulse-widget.js').then((module) => module.default),
  },
  onError: (_error, element) =>
    element.setAttribute('data-nv-island-failed', ''),
  onHydrationMismatch: (element, mismatch) =>
    element.setAttribute('data-nv-mismatch', mismatch.framework),
});
loader.start();
