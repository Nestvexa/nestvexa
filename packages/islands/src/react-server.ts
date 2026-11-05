import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import type { IslandContext } from './client.js';
import type { IslandServerRenderer } from './index.js';
import { serverIslandContext } from './server-context.js';

/** Server renderer for `IslandRegistry({ renderers })`; pair with `reactIsland`. */
export function reactIslandRenderer<Props extends object>(
  component: ComponentType<Props & { island: IslandContext<never> }>,
): IslandServerRenderer {
  return (props, context) =>
    renderToString(
      createElement(component, {
        ...(props as Props),
        island: serverIslandContext(context) as IslandContext<never>,
      }),
    );
}
