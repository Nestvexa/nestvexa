import type {
  InertiaPageLike,
  PageRegistry,
  SsrRender,
} from '@nestvexa/vite/pages';
import { render } from 'svelte/server';
import type { SveltePageModule } from './pages.js';
import { upstreamCreate, upstreamPage, upstreamResolver } from './upstream.js';
import type { UpstreamServerRender } from './upstream.js';
import type { SvelteCreateInertiaApp } from './types.js';

export { isMainModule, startOfficialSsrServer } from '@nestvexa/vite';
export type { SsrServerOptions } from '@nestvexa/vite';
export type { SsrRender, SsrRenderResult } from '@nestvexa/vite/pages';
export type { SvelteCreateInertiaApp } from './types.js';

export interface SvelteSsrOptions {
  /** `createInertiaApp` imported from `@inertiajs/svelte` by the SSR entry. */
  readonly createInertiaApp: SvelteCreateInertiaApp;
  readonly pages: PageRegistry<SveltePageModule>;
  /** Root element id; must match the client and the Nest app. Default `app`. */
  readonly id?: string;
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
}

/**
 * Builds the SSR render function on the official `@inertiajs/svelte` server
 * path with Svelte 5's `render` from `svelte/server`. The body is upstream
 * `buildSSRBody` output with `data-server-rendered`, which
 * `mountSvelteInertiaApp` passes to `hydrate()`. To run the official HTTP SSR
 * server, call `startOfficialSsrServer(createServer, render)` with
 * `createServer` from `@inertiajs/svelte/server`.
 */
export function createSvelteSsrRender(options: SvelteSsrOptions): SsrRender {
  const create = upstreamCreate(options.createInertiaApp);
  let pending: Promise<UpstreamServerRender> | undefined;
  const build = async (): Promise<UpstreamServerRender> => {
    const created = await create({
      id: options.id ?? 'app',
      resolve: upstreamResolver(options.pages),
      ...(options.layout ? { layout: options.layout } : {}),
    });
    if (typeof created !== 'function')
      throw new Error(
        '@inertiajs/svelte did not return an SSR render function',
      );
    return created;
  };
  return async (page) => {
    pending ??= build().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return (await pending)(upstreamPage(page), render);
  };
}
