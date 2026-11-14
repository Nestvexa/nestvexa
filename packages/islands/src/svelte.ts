import { hydrate, mount, unmount } from 'svelte';
import type { Component } from 'svelte';
import type { IslandContext, IslandMount } from './client.js';

/**
 * Mount a Svelte 5 component as an island with props and an `island` context
 * prop. Roots marked `data-nv-ssr` are hydrated. Svelte recovers from
 * mismatches by updating text or re-rendering the target; the adapter
 * compares the markup before and after the synchronous hydration pass and
 * reports any change through `context.reportMismatch`.
 *
 * Like `reactIsland`, components may declare required props (including
 * `island`): the props arrive from the markup at runtime, so this signature
 * cannot check them.
 */
export function svelteIsland<Props extends object, Services = unknown>(
  component: Component<Props & { island: IslandContext<Services> }>,
): IslandMount {
  return (element, props, context) => {
    const properties = {
      ...(props as Props),
      // The loader's services are application-typed by convention.
      island: context as IslandContext<Services>,
    };
    if (context.hydrate) {
      const before = element.innerHTML;
      const instance = hydrate(component, {
        target: element,
        props: properties,
      });
      if (element.innerHTML !== before)
        context.reportMismatch(
          'Svelte hydration changed the server-rendered markup',
        );
      return () => {
        void unmount(instance);
      };
    }
    element.replaceChildren();
    const instance = mount(component, {
      target: element,
      props: properties,
    });
    return () => {
      void unmount(instance);
    };
  };
}
