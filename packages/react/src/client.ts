import { createInertiaApp } from '@inertiajs/react';
import type {
  InertiaPageLike,
  PageRegistry,
  ProgressOptionsLike,
} from '@nestvexa/vite/pages';
import { StrictMode, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ErrorBoundary } from './boundary.js';
import type { ErrorFallback } from './boundary.js';
import type { ReactPageModule } from './pages.js';
import { upstreamResolver } from './upstream.js';

/** Where an error was observed. `recoverable` includes hydration mismatches. */
export type ReactErrorKind = 'boot' | 'render' | 'recoverable';

export interface ReactInertiaAppOptions {
  /** Explicit page registry (`createPageRegistry(import.meta.glob(...))`). */
  readonly pages: PageRegistry<ReactPageModule>;
  /** Root element id; must match the Nest app's `id`. Default `app`. */
  readonly id?: string;
  /** Document title callback for `<Head title>`. */
  readonly title?: (title: string, page: InertiaPageLike) => string;
  /** Default layout(s) for pages without their own `layout`. */
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
  /** Official progress bar options, or `false` to disable it. */
  readonly progress?: ProgressOptionsLike | false;
  /** Fallback for render errors caught by the root error boundary. */
  readonly fallback?: ErrorFallback;
  /**
   * Observes boot failures, caught render errors and recoverable errors
   * (React reports hydration mismatches here). Default: `console.error`.
   */
  readonly onError?: (error: unknown, kind: ReactErrorKind) => void;
  readonly strictMode?: boolean;
  /**
   * CSP nonce for elements the client injects (progress bar styles). Default:
   * the `<meta property="csp-nonce">` printed by `@nestvexa/vite`.
   */
  readonly nonce?: string;
}

export interface ReactInertiaAppHandle {
  /** `hydrate` when SSR markup was present, `mount` otherwise, `failed` on boot error. */
  readonly mode: 'hydrate' | 'mount' | 'failed';
  readonly root: Root | undefined;
  readonly error?: unknown;
}

const defaultOnError = (error: unknown, kind: ReactErrorKind): void => {
  console.error(`[nestvexa/react] ${kind} error`, error);
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
 * Boots the official `@inertiajs/react` client from the server page object:
 * `hydrateRoot` when the root carries `data-server-rendered` (SSR markup),
 * `createRoot` otherwise. The app is wrapped in an `ErrorBoundary`. A boot
 * failure (for example an unregistered page) is reported and leaves any
 * server-rendered markup in place instead of blanking the page.
 */
export async function mountReactInertiaApp(
  options: ReactInertiaAppOptions,
): Promise<ReactInertiaAppHandle> {
  const onError = options.onError ?? defaultOnError;
  const report = (error: unknown, kind: ReactErrorKind): void => {
    try {
      onError(error, kind);
    } catch {
      // Observers must not break booting.
    }
  };
  const state: { mode: ReactInertiaAppHandle['mode']; root?: Root } = {
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
      setup({ el, App, props }) {
        let tree: ReactElement = createElement(
          ErrorBoundary,
          {
            fallback: options.fallback,
            onError: (error: unknown) => report(error, 'render'),
          },
          createElement(App, props),
        );
        if (options.strictMode) tree = createElement(StrictMode, null, tree);
        const rootOptions = {
          onRecoverableError: (error: unknown) => report(error, 'recoverable'),
        };
        if (el.hasAttribute('data-server-rendered')) {
          state.mode = 'hydrate';
          state.root = hydrateRoot(el, tree, rootOptions);
        } else {
          state.mode = 'mount';
          state.root = createRoot(el, rootOptions);
          state.root.render(tree);
        }
      },
    });
  } catch (error) {
    report(error, 'boot');
    return { mode: 'failed', root: state.root, error };
  }
  return { mode: state.mode, root: state.root };
}
