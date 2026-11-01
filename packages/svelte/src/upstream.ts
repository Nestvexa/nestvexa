// Internal bridge to the official `@inertiajs/svelte` 3.x `createInertiaApp`.
// It is typed structurally here because (a) `@inertiajs/svelte` publishes only
// the `svelte` export condition, so this package cannot import it at runtime in
// plain Node and receives `createInertiaApp` from the application, and (b) its
// 3.10.0 declarations do not type-check with `skipLibCheck: false`
// (`Render.svelte.d.ts` TS2440). The shape mirrors
// `@inertiajs/svelte/dist/createInertiaApp.d.ts` 3.10.0.
import type { Page } from '@inertiajs/core';
import type {
  InertiaPageLike,
  PageRegistry,
  ProgressOptionsLike,
  SsrRenderResult,
} from '@nestvexa/vite/pages';
import type { Component } from 'svelte';
import type { render } from 'svelte/server';
import { createSveltePageResolver } from './pages.js';
import type { SveltePageModule } from './pages.js';

import type { SvelteCreateInertiaApp } from './types.js';

/** Opaque props upstream passes to its root `App` component. */
type UpstreamAppProps = Record<string, unknown>;

interface UpstreamSetupOptions {
  readonly el: HTMLElement | null;
  readonly App: Component<UpstreamAppProps>;
  readonly props: UpstreamAppProps;
}

export type UpstreamServerRender = (
  page: Page,
  renderer: typeof render,
) => Promise<SsrRenderResult>;

interface UpstreamOptions {
  readonly id?: string;
  readonly resolve: (name: string) => Promise<SveltePageModule>;
  readonly layout?: (name: string, page: InertiaPageLike) => unknown;
  readonly progress?: ProgressOptionsLike | false;
  readonly nonce?: string;
  readonly setup?: (options: UpstreamSetupOptions) => void;
}

type UpstreamCreateInertiaApp = (
  options: UpstreamOptions,
) => Promise<void | UpstreamServerRender>;

export function upstreamCreate(
  create: SvelteCreateInertiaApp,
): UpstreamCreateInertiaApp {
  if (typeof create !== 'function')
    throw new TypeError(
      'Pass createInertiaApp from @inertiajs/svelte as the createInertiaApp option',
    );
  return create as UpstreamCreateInertiaApp;
}

export function upstreamResolver(
  registry: PageRegistry<SveltePageModule>,
): (name: string) => Promise<SveltePageModule> {
  return createSveltePageResolver(registry);
}

export function upstreamPage(page: InertiaPageLike): Page {
  return page as Page;
}
