import { createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import type { IslandContext, IslandMount } from './client.js';

/**
 * Mount a React component as an island. Roots marked `data-nv-ssr` are
 * hydrated; React's recoverable hydration errors (text/structure
 * mismatches, after which React re-renders on the client) are reported
 * through `context.reportMismatch`.
 */
export function reactIsland<Props extends object, Services = unknown>(
  component: ComponentType<Props & { island: IslandContext<Services> }>,
): IslandMount {
  return (element, props, context) => {
    const node = createElement(component, {
      ...(props as Props),
      // The loader's services are application-typed by convention.
      island: context as IslandContext<Services>,
    });
    if (context.hydrate) {
      const root = hydrateRoot(element, node, {
        onRecoverableError: (error: unknown) =>
          context.reportMismatch(
            error instanceof Error ? error.message : String(error),
          ),
      });
      return () => root.unmount();
    }
    const root = createRoot(element);
    root.render(node);
    return () => root.unmount();
  };
}
