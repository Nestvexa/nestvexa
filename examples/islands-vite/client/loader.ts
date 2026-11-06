import { createIslands, parseIslandManifest } from '@nestvexa/islands/client';
import manifestJson from '../dist/islands/.vite/islands-manifest.json';
import { hooks, start } from './observe.js';

/**
 * Production loader (its own Vite build, after the islands build): the
 * island manifest written by `islandsVitePlugin` is bundled in as the
 * allowlist, and each island loads only from its manifest bundle path.
 */
start(createIslands({ manifest: parseIslandManifest(manifestJson), ...hooks }));
