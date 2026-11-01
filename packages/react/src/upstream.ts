// Internal bridge to upstream `@inertiajs/*` types. Never re-exported, so the
// public declarations stay independent of upstream type packages (whose
// declarations require `moduleResolution: "bundler"`).
import type { Page } from '@inertiajs/core';
import type { ResolvedComponent } from '@inertiajs/react';
import type { InertiaPageLike, PageRegistry } from '@nestvexa/vite/pages';
import { createReactPageResolver } from './pages.js';
import type { ReactPageModule } from './pages.js';

export function upstreamResolver(
  registry: PageRegistry<ReactPageModule>,
): (name: string) => Promise<ResolvedComponent> {
  const resolve = createReactPageResolver(registry);
  return async (name) => (await resolve(name)) as ResolvedComponent;
}

export function upstreamPage(page: InertiaPageLike): Page {
  return page as Page;
}
