// Internal bridge to upstream `@inertiajs/*` types. Never re-exported, so the
// public declarations stay independent of upstream type packages (whose
// declarations require `moduleResolution: "bundler"`).
import type { Page } from '@inertiajs/core';
import type { PageRegistry, InertiaPageLike } from '@nestvexa/vite/pages';
import type { DefineComponent } from 'vue';
import { createVuePageResolver } from './pages.js';
import type { VuePageModule } from './pages.js';

export function upstreamResolver(
  registry: PageRegistry<VuePageModule>,
): (name: string) => Promise<DefineComponent> {
  const resolve = createVuePageResolver(registry);
  return async (name) => (await resolve(name)) as DefineComponent;
}

export function upstreamPage(page: InertiaPageLike): Page {
  return page as Page;
}
