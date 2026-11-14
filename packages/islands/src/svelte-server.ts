import type { Component } from 'svelte';
import { render } from 'svelte/server';
import type { IslandContext } from './client.js';
import type { IslandServerRenderer } from './index.js';
import { serverIslandContext } from './server-context.js';
import type { IslandRendererOptions } from './server-context.js';

export type { IslandRendererOptions } from './server-context.js';

/**
 * Server renderer for `IslandRegistry({ renderers })`; pair with
 * `svelteIsland`. The component must be compiled with `generate: 'server'`.
 * Only the body is used: islands do not inject `<head>` content.
 */
export function svelteIslandRenderer<Props extends object, Services = unknown>(
  component: Component<Props & { island: IslandContext<Services> }>,
  options: IslandRendererOptions = {},
): IslandServerRenderer {
  return (props, context) =>
    render(component, {
      props: {
        ...(props as Props),
        // Server services are application-typed by convention, like the loader's.
        island: serverIslandContext(
          context,
          options,
        ) as IslandContext<Services>,
      },
    }).body;
}
