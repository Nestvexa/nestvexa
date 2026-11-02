import { mount, unmount } from 'svelte';
import type { Component } from 'svelte';
import type { IslandMount } from './client.js';

/** Mount a Svelte 5 component as an island with props and an `island` context prop. */
export function svelteIsland(
  component: Component<Record<string, unknown>>,
): IslandMount {
  return (element, props, context) => {
    element.replaceChildren();
    const instance = mount(component, {
      target: element,
      props: { ...props, island: context },
    });
    return () => {
      void unmount(instance);
    };
  };
}
