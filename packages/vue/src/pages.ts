import { PageNotFoundError } from '@nestvexa/vite/pages';
import type { PageRegistry } from '@nestvexa/vite/pages';
import type { Component } from 'vue';

/** A `.vue` page module: the default export is the page component. */
export interface VuePageModule {
  readonly default: Component;
}

/**
 * Selects one page's props from a props map shared by Nest controllers and
 * page components (`PageProps<AppPages, 'Users/Index'>`).
 */
export type PageProps<
  TMap extends Readonly<Record<string, object>>,
  TName extends keyof TMap,
> = TMap[TName];

function isComponent(value: unknown): value is Component {
  return (
    typeof value === 'function' || (typeof value === 'object' && value !== null)
  );
}

/**
 * Resolver for `createInertiaApp({ resolve })` over an explicit page
 * registry. Unknown names reject with `PageNotFoundError`, and so does a module
 * without a component default export.
 */
export function createVuePageResolver(
  registry: PageRegistry<VuePageModule>,
): (name: string) => Promise<Component> {
  return async (name) => {
    const module = await registry.load(name);
    const component: unknown = module?.default;
    if (!isComponent(component)) throw new PageNotFoundError(name);
    return component;
  };
}
