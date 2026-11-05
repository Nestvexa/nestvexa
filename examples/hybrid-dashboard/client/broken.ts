import type { IslandMount } from '@nestvexa/islands/client';

/** Demonstration failure: the loader keeps the fallback and marks the root. */
const mount: IslandMount = () => {
  throw new Error('Demonstration failure');
};
export default mount;
