import type { Page } from '@inertiajs/core';
import { createInertiaApp } from '@inertiajs/vue3';
import createServer from '@inertiajs/vue3/server';
import { startOfficialSsrServer } from '@nestvexa/vite';
import type { SsrServerOptions } from '@nestvexa/vite';
import type {
  InertiaPageLike,
  PageRegistry,
  SsrRender,
  SsrRenderResult,
} from '@nestvexa/vite/pages';
import { createSSRApp, h } from 'vue';
import type { App } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { ErrorBoundary } from './boundary.js';
import type { VuePageModule } from './pages.js';
import { upstreamPage, upstreamResolver } from './upstream.js';

export { isMainModule } from '@nestvexa/vite';
export type { SsrServerOptions } from '@nestvexa/vite';
export type { SsrRender, SsrRenderResult } from '@nestvexa/vite/pages';

export interface VueSsrOptions {
  readonly pages: PageRegistry<VuePageModule>;
  /** Root element id; must match the client and the Nest app. Default `app`. */
  readonly id?: string;
  readonly title?: (title: string, page: InertiaPageLike) => string;
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
  /** Install the same plugins as the client (must not touch browser APIs). */
  readonly enhance?: (app: App) => void;
}

type ServerRender = (
  page: Page,
  render: (app: App) => Promise<string>,
) => Promise<SsrRenderResult>;

/**
 * Builds the SSR render function on the official `@inertiajs/vue3` server
 * path and `vue/server-renderer`'s `renderToString`. A fresh `createSSRApp` is
 * created per render (no state shared between requests). Render errors
 * reject the render so the Nest adapter's fallback/strict mode decides: the
 * SSR boundary does not swallow them, and because Vue's production build only
 * logs unhandled component errors during SSR (rendering empty markup), each app
 * gets an `errorHandler` that records the first error and fails the render.
 * Body: upstream `buildSSRBody` output.
 */
export function createVueSsrRender(options: VueSsrOptions): SsrRender {
  let pending: Promise<ServerRender> | undefined;
  const failures = new WeakMap<App, { readonly error: unknown }>();
  const renderStrict = async (app: App): Promise<string> => {
    const html = await renderToString(app);
    const failure = failures.get(app);
    if (failure) throw failure.error;
    return html;
  };
  const create = async (): Promise<ServerRender> => {
    const created = await createInertiaApp({
      id: options.id ?? 'app',
      resolve: upstreamResolver(options.pages),
      ...(options.title ? { title: options.title } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
      setup: ({ App: InertiaApp, props, plugin }) => {
        const app = createSSRApp({
          render: () =>
            h(ErrorBoundary, null, { default: () => h(InertiaApp, props) }),
        });
        app.use(plugin);
        options.enhance?.(app);
        const enhanced = app.config.errorHandler;
        app.config.errorHandler = (error, instance, info) => {
          if (!failures.has(app)) failures.set(app, { error });
          enhanced?.(error, instance, info);
        };
        return app;
      },
    });
    if (typeof created !== 'function')
      throw new Error('@inertiajs/vue3 did not return an SSR render function');
    return created;
  };
  return async (page) => {
    pending ??= create().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return (await pending)(upstreamPage(page), renderStrict);
  };
}

/**
 * Starts the official Inertia SSR HTTP server (`@inertiajs/vue3/server`) for
 * a render function, bound to `127.0.0.1:13714` unless configured.
 */
export function startVueSsrServer(
  render: SsrRender,
  options: SsrServerOptions = {},
): void {
  startOfficialSsrServer(createServer, render, options);
}
