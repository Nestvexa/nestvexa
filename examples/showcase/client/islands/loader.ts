import { createIslands } from '@nestvexa/islands/client';

/**
 * Islands loader for the HBS pages. The allowlist is this build-time map of
 * bundler-resolved imports: markup can only name an id listed here, and the
 * module URL never comes from the page. Each island is a lazy chunk.
 */
const loader = createIslands({
  modules: {
    'throughput-chart': () =>
      import('./throughput-chart.js').then((module) => module.default),
  },
  onError: (_error, element) =>
    element.setAttribute('data-nv-island-failed', ''),
});
loader.start();
