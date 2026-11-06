import type { IslandsLoader, IslandsOptions } from '@nestvexa/islands/client';

interface Debug {
  nvIslands?: IslandsLoader;
  nvIslandMismatches?: string[];
}
const debug = window as unknown as Debug;
const mismatches: string[] = [];
debug.nvIslandMismatches = mismatches;

/** Loader hooks shared by the production and development loaders. */
export const hooks: Pick<IslandsOptions, 'onError' | 'onHydrationMismatch'> = {
  onError: (_error, element) =>
    element.setAttribute('data-nv-island-failed', ''),
  onHydrationMismatch: (_element, mismatch) => {
    mismatches.push(`${mismatch.id}:${mismatch.framework}`);
  },
};

/** Starts the loader and exposes it for diagnostics (`window.nvIslands`). */
export function start(loader: IslandsLoader): void {
  loader.start();
  debug.nvIslands = loader;
}
