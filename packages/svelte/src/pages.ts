import { PageNotFoundError } from '@nestvexa/vite/pages';
import type { PageRegistry } from '@nestvexa/vite/pages';
import type { Component } from 'svelte';

/**
 * A `.svelte` page module: the default export is the component; an optional
 * `layout` export (from `<script module>`) sets its persistent layout.
 */
export interface SveltePageModule {
  readonly default: Component<never>;
  readonly layout?: unknown;
}

/**
 * Selects one page's props from a props map shared by Nest controllers and
 * page components (`PageProps<AppPages, 'Users/Index'>`).
 */
export type PageProps<
  TMap extends Readonly<Record<string, object>>,
  TName extends keyof TMap,
> = TMap[TName];

/**
 * Resolver for `createInertiaApp({ resolve })` over an explicit page
 * registry. Resolves to the page module (the shape `@inertiajs/svelte`
 * expects, so a module-level `layout` export keeps working). Unknown names and
 * modules without a component default export reject with `PageNotFoundError`.
 */
export function createSveltePageResolver(
  registry: PageRegistry<SveltePageModule>,
): (name: string) => Promise<SveltePageModule> {
  return async (name) => {
    const module = await registry.load(name);
    if (typeof module?.default !== 'function')
      throw new PageNotFoundError(name);
    return module;
  };
}
