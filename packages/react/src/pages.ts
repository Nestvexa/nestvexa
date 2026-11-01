import { PageNotFoundError } from '@nestvexa/vite/pages';
import type { PageRegistry } from '@nestvexa/vite/pages';
import type { ComponentType } from 'react';

/** Any page component, optionally with an Inertia persistent `layout`. */
export type ReactPageComponent = ComponentType<never> & {
  layout?: unknown;
};

/** A page module: the default export is the page component. */
export interface ReactPageModule {
  readonly default: ReactPageComponent;
}

/**
 * Selects one page's props from a props map shared by Nest controllers and
 * page components (`PageProps<AppPages, 'Users/Index'>`).
 */
export type PageProps<
  TMap extends Readonly<Record<string, object>>,
  TName extends keyof TMap,
> = TMap[TName];

function isComponent(value: unknown): boolean {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value)
  );
}

/**
 * Resolver for `createInertiaApp({ resolve })` over an explicit page
 * registry. Unknown names reject with `PageNotFoundError`, and so does a module
 * whose default export is not a component.
 */
export function createReactPageResolver(
  registry: PageRegistry<ReactPageModule>,
): (name: string) => Promise<ReactPageComponent> {
  return async (name) => {
    const module = await registry.load(name);
    const component: unknown = module?.default;
    if (!isComponent(component)) throw new PageNotFoundError(name);
    return component as ReactPageComponent;
  };
}
