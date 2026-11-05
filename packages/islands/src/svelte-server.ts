import type { Component } from 'svelte';
import { render } from 'svelte/server';
import type { IslandServerRenderer } from './index.js';
import { serverIslandContext } from './server-context.js';

/**
 * Server renderer for `IslandRegistry({ renderers })`; pair with
 * `svelteIsland`. The component must be compiled with `generate: 'server'`.
 * Only the body is used: islands do not inject `<head>` content.
 */
export function svelteIslandRenderer(
  component: Component<Record<string, unknown>>,
): IslandServerRenderer {
  return (props, context) =>
    render(component, {
      props: { ...props, island: serverIslandContext(context) },
    }).body;
}
