import { createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import type { IslandContext, IslandMount } from './client.js';

/** Mount a React component as an island; hydrates when `data-nv-ssr` is present. */
export function reactIsland<Props extends object>(
  component: ComponentType<Props & { island: IslandContext }>,
): IslandMount {
  return (element, props, context) => {
    const node = createElement(component, {
      ...(props as Props),
      island: context,
    });
    const root = element.hasAttribute('data-nv-ssr')
      ? hydrateRoot(element, node)
      : createRoot(element);
    if (!element.hasAttribute('data-nv-ssr')) root.render(node);
    return () => root.unmount();
  };
}
