import type { IslandContext } from './client.js';
import type { IslandServerContext } from './index.js';

/**
 * Inert `island` prop for server rendering: components can read `shared`
 * and call `on`/`emit` during setup without side effects. `hydrate` is true
 * so server and client renders take the same branch.
 */
export function serverIslandContext(
  context: IslandServerContext,
): IslandContext<undefined> {
  return Object.freeze({
    id: context.id,
    signal: new AbortController().signal,
    shared: context.shared,
    services: undefined,
    hydrate: true,
    signed: undefined,
    reportMismatch: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
  });
}
