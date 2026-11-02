import { createInertiaApp } from '@inertiajs/vue3';
import type {
  InertiaPageLike,
  PageRegistry,
  ProgressOptionsLike,
} from '@nestvexa/vite/pages';
import { createApp, createSSRApp, h } from 'vue';
import type { App } from 'vue';
import { ErrorBoundary } from './boundary.js';
import type { VuePageModule } from './pages.js';
import { upstreamResolver } from './upstream.js';

/** Where an error was observed. Vue reports hydration mismatches via the console. */
export type VueErrorKind = 'boot' | 'render';

export interface VueInertiaAppOptions {
  /** Explicit page registry (`createPageRegistry(import.meta.glob(...))`). */
  readonly pages: PageRegistry<VuePageModule>;
  /** Root element id; must match the Nest app's `id`. Default `app`. */
  readonly id?: string;
  readonly title?: (title: string, page: InertiaPageLike) => string;
  /** Default layout(s) for pages without their own `layout`. */
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
  readonly progress?: ProgressOptionsLike | false;
  /** Install plugins (router-independent stores, i18n…) before mounting. */
  readonly enhance?: (app: App) => void;
  /** Observes boot failures and errors caught by the root boundary. Default `console.error`. */
  readonly onError?: (error: unknown, kind: VueErrorKind) => void;
  /** CSP nonce for injected styles. Default: `<meta property="csp-nonce">`. */
  readonly nonce?: string;
}

export interface VueInertiaAppHandle {
  readonly mode: 'hydrate' | 'mount' | 'failed';
  readonly app: App | undefined;
  readonly error?: unknown;
}

const defaultOnError = (error: unknown, kind: VueErrorKind): void => {
  console.error(`[nestvexa/vue] ${kind} error`, error);
};

/** Reads the nonce `@nestvexa/vite` prints on `<meta property="csp-nonce">`. */
export function metaNonce(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[property="csp-nonce"]',
  );
  const nonce = meta?.nonce || meta?.getAttribute('nonce');
  return nonce ? nonce : undefined;
}

/**
 * Boots the official `@inertiajs/vue3` client: `createSSRApp(...).mount()`
 * (hydration) when the root carries `data-server-rendered`, `createApp`
 * otherwise, with the Inertia plugin and a root `ErrorBoundary`. Boot failures
 * are reported and leave server markup in place.
 */
export async function mountVueInertiaApp(
  options: VueInertiaAppOptions,
): Promise<VueInertiaAppHandle> {
  const onError = options.onError ?? defaultOnError;
  const report = (error: unknown, kind: VueErrorKind): void => {
    try {
      onError(error, kind);
    } catch {
      // Observers must not break booting.
    }
  };
  const state: { mode: VueInertiaAppHandle['mode']; app?: App } = {
    mode: 'failed',
  };
  const nonce = options.nonce ?? metaNonce();
  try {
    await createInertiaApp({
      id: options.id ?? 'app',
      resolve: upstreamResolver(options.pages),
      ...(options.title ? { title: options.title } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
      ...(nonce ? { nonce } : {}),
      setup({ el, App: InertiaApp, props, plugin }) {
        const hydrate = el.hasAttribute('data-server-rendered');
        const app = (hydrate ? createSSRApp : createApp)({
          render: () =>
            h(
              ErrorBoundary,
              { onError: (error: unknown) => report(error, 'render') },
              { default: () => h(InertiaApp, props) },
            ),
        });
        app.use(plugin);
        options.enhance?.(app);
        app.mount(el);
        state.mode = hydrate ? 'hydrate' : 'mount';
        state.app = app;
      },
    });
  } catch (error) {
    report(error, 'boot');
    return { mode: 'failed', app: state.app, error };
  }
  return { mode: state.mode, app: state.app };
}
