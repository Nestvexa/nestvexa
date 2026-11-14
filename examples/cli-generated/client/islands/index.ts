import { createIslands } from '@nestvexa/islands/client';
import type { IslandModules } from '@nestvexa/islands/client';

/** Build-time allowlist: markup can only select ids listed here. */
const modules: IslandModules = {
  clicker: () => import('./clicker').then((module) => module.default),
  feed: () => import('./feed.island').then((module) => module.default),
  status: () => import('./status.island').then((module) => module.default),
  // nestvexa:island-modules
};

createIslands({ modules }).start();
