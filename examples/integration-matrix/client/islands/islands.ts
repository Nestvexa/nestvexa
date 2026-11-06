import {
  createActionsClient,
  isActionClientError,
} from '@nestvexa/actions/client';
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
  },
  onError: (_error, element) => {
    element.setAttribute('data-nv-island-failed', '');
  },
});
loader.start();

/*
 * Universal server action call. The descriptor names a server-registered
 * action; `@nestvexa/actions/codegen` can generate it with typed input/output
 * (see examples/actions-basic). The CSRF token is read from
 * <meta name="nestvexa-csrf">.
 */
const actions = createActionsClient();
const addPoints = {
  group: 'scoreboard',
  action: 'add-points',
  version: null,
  idempotent: false,
} as const;
const button = document.getElementById('score-add');
const input = document.getElementById('score-points');
const total = document.getElementById('score-total');
const status = document.getElementById('score-status');
if (button instanceof HTMLButtonElement && input instanceof HTMLInputElement)
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await actions.call(addPoints, {
        points: Number(input.value),
      });
      const value =
        typeof result === 'object' && result !== null
          ? Reflect.get(result, 'total')
          : undefined;
      if (total) total.textContent = String(value);
      if (status) status.textContent = 'Points added.';
    } catch (error) {
      if (status)
        status.textContent = isActionClientError(error)
          ? `Refused: ${error.code}`
          : 'The action failed.';
    } finally {
      button.disabled = false;
    }
  });
