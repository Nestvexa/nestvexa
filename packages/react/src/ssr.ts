import type { Page } from '@inertiajs/core';
import { createInertiaApp } from '@inertiajs/react';
import createServer from '@inertiajs/react/server';
import { startOfficialSsrServer } from '@nestvexa/vite';
import type { SsrServerOptions } from '@nestvexa/vite';
import type {
  InertiaPageLike,
  PageRegistry,
  SsrRender,
  SsrRenderResult,
} from '@nestvexa/vite/pages';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ErrorBoundary } from './boundary.js';
import type { ReactPageModule } from './pages.js';
import { upstreamPage, upstreamResolver } from './upstream.js';

export { isMainModule } from '@nestvexa/vite';
export type { SsrServerOptions } from '@nestvexa/vite';
export type { SsrRender, SsrRenderResult } from '@nestvexa/vite/pages';

export interface ReactSsrOptions {
  readonly pages: PageRegistry<ReactPageModule>;
  /** Root element id; must match the client and the Nest app. Default `app`. */
  readonly id?: string;
  readonly title?: (title: string, page: InertiaPageLike) => string;
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
}

type ServerRender = (
  page: Page,
  render: typeof renderToString,
) => Promise<SsrRenderResult>;

/**
 * Builds the SSR render function on the official `@inertiajs/react` server
 * path (`createInertiaApp` without a page) and React's `renderToString`. The
 * `body` is upstream `buildSSRBody` output — the page script plus
 * `<div data-server-rendered="true">` — which `mountReactInertiaApp` hydrates.
 * Export it from the SSR entry for in-process rendering, or serve it with
 * `startReactSsrServer` for `HttpSsrGateway`.
 */
export function createReactSsrRender(options: ReactSsrOptions): SsrRender {
  let pending: Promise<ServerRender> | undefined;
  const create = async (): Promise<ServerRender> => {
    const created = await createInertiaApp({
      id: options.id ?? 'app',
      resolve: upstreamResolver(options.pages),
      ...(options.title ? { title: options.title } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
      setup: ({ App, props }) =>
        createElement(ErrorBoundary, null, createElement(App, props)),
    });
    if (typeof created !== 'function')
      throw new Error('@inertiajs/react did not return an SSR render function');
    return created;
  };
  return async (page) => {
    pending ??= create().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return (await pending)(upstreamPage(page), renderToString);
  };
}

/**
 * Starts the official Inertia SSR HTTP server (`@inertiajs/react/server`) for
 * a render function, bound to `127.0.0.1:13714` unless configured.
 */
export function startReactSsrServer(
  render: SsrRender,
  options: SsrServerOptions = {},
): void {
  startOfficialSsrServer(createServer, render, options);
}
