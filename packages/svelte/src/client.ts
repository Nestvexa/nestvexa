import type {
  InertiaPageLike,
  PageRegistry,
  ProgressOptionsLike,
} from '@nestvexa/vite/pages';
import { hydrate, mount } from 'svelte';
import type { SveltePageModule } from './pages.js';
import { upstreamCreate, upstreamResolver } from './upstream.js';
import type { SvelteCreateInertiaApp } from './types.js';

export type { SvelteCreateInertiaApp } from './types.js';

export interface SvelteInertiaAppOptions {
  /** `createInertiaApp` imported from `@inertiajs/svelte` by the application. */
  readonly createInertiaApp: SvelteCreateInertiaApp;
  /** Explicit page registry (`createPageRegistry(import.meta.glob(...))`). */
  readonly pages: PageRegistry<SveltePageModule>;
  /** Root element id; must match the Nest app's `id`. Default `app`. */
  readonly id?: string;
  /** Default layout(s) for pages without their own `layout` export. */
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
  readonly progress?: ProgressOptionsLike | false;
  /** Observes boot failures (including errors thrown while hydrating/mounting). */
  readonly onError?: (error: unknown) => void;
  /** CSP nonce for injected styles. Default: `<meta property="csp-nonce">`. */
  readonly nonce?: string;
}

export interface SvelteInertiaAppHandle {
  readonly mode: 'hydrate' | 'mount' | 'failed';
  readonly error?: unknown;
}

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
 * Boots the official `@inertiajs/svelte` client with Svelte 5's API:
 * `hydrate()` when the root carries `data-server-rendered`, `mount()`
 * otherwise. Svelte has no component-level error boundary API outside
 * templates; wrap layouts in `<svelte:boundary>` for render errors. Boot
 * failures are reported and leave server markup in place.
 */
export async function mountSvelteInertiaApp(
  options: SvelteInertiaAppOptions,
): Promise<SvelteInertiaAppHandle> {
  const create = upstreamCreate(options.createInertiaApp);
  const report = (error: unknown): void => {
    try {
      (
        options.onError ??
        ((value: unknown) =>
          console.error('[nestvexa/svelte] boot error', value))
      )(error);
    } catch {
      // Observers must not break booting.
    }
  };
  const state: { mode: SvelteInertiaAppHandle['mode'] } = { mode: 'failed' };
  const nonce = options.nonce ?? metaNonce();
  try {
    await create({
      id: options.id ?? 'app',
      resolve: upstreamResolver(options.pages),
      ...(options.layout ? { layout: options.layout } : {}),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
      ...(nonce ? { nonce } : {}),
      setup({ el, App, props }) {
        if (!el)
          throw new Error(`Inertia root #${options.id ?? 'app'} missing`);
        if (el.hasAttribute('data-server-rendered')) {
          hydrate(App, { target: el, props });
          state.mode = 'hydrate';
        } else {
          mount(App, { target: el, props });
          state.mode = 'mount';
        }
      },
    });
  } catch (error) {
    report(error);
    return { mode: 'failed', error };
  }
  return { mode: state.mode };
}
