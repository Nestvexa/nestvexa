import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import type { IslandContext } from './client.js';
import type { IslandServerRenderer } from './index.js';
import { serverIslandContext } from './server-context.js';
import type { IslandRendererOptions } from './server-context.js';

export type { IslandRendererOptions } from './server-context.js';

/** Server renderer for `IslandRegistry({ renderers })`; pair with `reactIsland`. */
export function reactIslandRenderer<Props extends object, Services = unknown>(
  component: ComponentType<Props & { island: IslandContext<Services> }>,
  options: IslandRendererOptions = {},
): IslandServerRenderer {
  return (props, context) =>
    renderToString(
      createElement(component, {
        ...(props as Props),
        // Server services are application-typed by convention, like the loader's.
        island: serverIslandContext(context, options) as IslandContext<Services>,
      }),
    );
}
