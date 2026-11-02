import { defineComponent, h, onErrorCaptured, ref, watch } from 'vue';
import type { PropType, VNode } from 'vue';

/** Accessible default fallback: an alert with a full-reload link. */
export function defaultErrorFallback(): VNode {
  return h('div', { role: 'alert', 'data-nestvexa-error': 'render' }, [
    h('p', 'Something went wrong while rendering this page.'),
    h('a', { href: '' }, 'Reload the page'),
  ]);
}

/**
 * Vue error boundary for Inertia pages (`onErrorCaptured`). Renders the
 * `fallback` slot (`{ error, reset }`) or an accessible default after a
 * descendant throws, and clears when the `resetKey` string changes (pass the
 * page URL).
 * During SSR it does not swallow errors: they propagate to the renderer so
 * `@nestvexa/inertia` can apply its fallback/strict mode instead of shipping
 * markup that the client would not reproduce. The error is never rendered.
 */
export const ErrorBoundary = defineComponent({
  name: 'NestvexaErrorBoundary',
  props: {
    resetKey: { type: String, required: false },
    onError: {
      type: Function as PropType<(error: unknown) => void>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const failed = ref(false);
    const caught = ref<unknown>(undefined);
    const reset = (): void => {
      failed.value = false;
      caught.value = undefined;
    };
    watch(() => props.resetKey, reset);
    onErrorCaptured((error) => {
      if (typeof window === 'undefined') return true;
      failed.value = true;
      caught.value = error;
      try {
        props.onError?.(error);
      } catch {
        // Observers must not break the fallback.
      }
      return false;
    });
    return () =>
      failed.value
        ? (slots['fallback']?.({ error: caught.value, reset }) ??
          defaultErrorFallback())
        : slots['default']?.();
  },
});
