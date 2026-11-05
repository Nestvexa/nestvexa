import { createSSRApp } from 'vue';
import type { Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { IslandServerRenderer } from './index.js';
import { serverIslandContext } from './server-context.js';
import type { IslandRendererOptions } from './server-context.js';

export type { IslandRendererOptions } from './server-context.js';

/** Server renderer for `IslandRegistry({ renderers })`; pair with `vueIsland`. */
export function vueIslandRenderer(
  component: Component,
  options: IslandRendererOptions = {},
): IslandServerRenderer {
  return (props, context) =>
    renderToString(
      createSSRApp(component, {
        ...props,
        island: serverIslandContext(context, options),
      }),
    );
}
