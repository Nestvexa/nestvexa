import type { IslandContext } from './client.js';
import type { IslandServerContext } from './index.js';

export interface IslandRendererOptions {
  /**
   * Server-side stand-in for the loader's `services` (for example an actions
   * client whose calls reject), so components that create hooks or stores
   * during render work on the server. Default undefined.
   */
  readonly services?: unknown;
}

/**
 * Inert `island` prop for server rendering: components can read `shared`
 * and call `on`/`emit` during setup without side effects. `hydrate` is true
 * so server and client renders take the same branch.
 */
export function serverIslandContext(
  context: IslandServerContext,
  options: IslandRendererOptions = {},
): IslandContext {
  return Object.freeze({
    id: context.id,
    signal: new AbortController().signal,
    shared: context.shared,
    services: options.services,
    hydrate: true,
    signed: undefined,
    reportMismatch: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
  });
}
