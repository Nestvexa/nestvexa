import type { IslandContext } from '@nestvexa/islands/client';
import type { NestvexaActions } from './generated/actions-client.js';

/** Services the loader hands to every island: the generated, typed actions client. */
export interface DashboardServices {
  readonly actions: NestvexaActions;
}
export type DashboardIsland = IslandContext<DashboardServices>;
