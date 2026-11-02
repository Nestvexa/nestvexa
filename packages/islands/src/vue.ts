import { createApp } from 'vue';
import type { Component } from 'vue';
import type { IslandMount } from './client.js';

/** Mount a Vue 3 component as an island with props and an `island` context prop. */
export function vueIsland(component: Component): IslandMount {
  return (element, props, context) => {
    const app = createApp(component, { ...props, island: context });
    app.mount(element);
    return () => app.unmount();
  };
}
