import { createApp, createSSRApp } from 'vue';
import type { Component } from 'vue';
import type { IslandMount } from './client.js';

/**
 * Mount a Vue 3 component as an island with props and an `island` context
 * prop. Roots marked `data-nv-ssr` are hydrated with `createSSRApp`. Vue
 * production builds only log mismatches, so the adapter compares the DOM
 * before and after the synchronous hydration pass: Vue repairs text and
 * structure mismatches in place, which changes the markup and is reported
 * through `context.reportMismatch`. Attribute-only mismatches are not
 * repaired by Vue in production and therefore not detected.
 */
export function vueIsland(component: Component): IslandMount {
  return (element, props, context) => {
    const properties = { ...props, island: context };
    if (context.hydrate) {
      const before = element.innerHTML;
      const app = createSSRApp(component, properties);
      app.mount(element);
      if (element.innerHTML !== before)
        context.reportMismatch(
          'Vue hydration changed the server-rendered markup',
        );
      return () => app.unmount();
    }
    const app = createApp(component, properties);
    app.mount(element);
    return () => app.unmount();
  };
}
