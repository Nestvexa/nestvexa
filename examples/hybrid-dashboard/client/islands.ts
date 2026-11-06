import { createActionsClient } from '@nestvexa/actions/client';
import { createIslands, parseIslandManifest } from '@nestvexa/islands/client';
import { createActions } from './generated/actions-client.js';
import manifestJson from './generated/islands-manifest.json';
import type { DashboardServices } from './services.js';

/**
 * The build-time manifest is bundled into the loader (never read from the
 * page): it is the allowlist, and each island loads from its manifest
 * bundle path as a separate, lazily imported chunk graph.
 */
const manifest = parseIslandManifest(manifestJson);
const services: DashboardServices = {
  // CSRF comes from <meta name="nestvexa-csrf">; identity from the session cookie.
  actions: createActions(createActionsClient()),
};
const mismatches: string[] = [];
const loader = createIslands<DashboardServices>({
  manifest,
  services,
  onError: (_error, element) => {
    element.setAttribute('data-nv-island-failed', '');
  },
  onHydrationMismatch: (_element, mismatch) => {
    mismatches.push(`${mismatch.id}:${mismatch.framework}`);
  },
});
loader.start();
const debug = window as unknown as {
  nvIslands?: typeof loader;
  nvIslandMismatches?: string[];
};
debug.nvIslands = loader;
debug.nvIslandMismatches = mismatches;
