import { createIslands } from '@nestvexa/islands/client';

/** Build-time allowlist; each framework is a separate lazily loaded chunk. */
const loader = createIslands({
  modules: {
    'revenue-chart': () =>
      import('./react-chart.js').then((module) => module.default),
    'activity-feed': () =>
      import('./vue-feed.js').then((module) => module.default),
    'status-widget': () =>
      import('./svelte-widget.js').then((module) => module.default),
    'broken-island': () => Promise.reject(new Error('Demonstration failure')),
  },
  onError: (_error, element) => {
    element.setAttribute('data-nv-island-failed', '');
  },
});
loader.start();
(window as unknown as { nvIslands?: typeof loader }).nvIslands = loader;
