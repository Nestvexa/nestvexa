import { Logger } from '@nestjs/common';
import { IslandRegistry, moduleIslandRenderers } from '@nestvexa/islands';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleRoot } from './config.js';

const logger = new Logger('Islands');

/**
 * Server-side island allowlist with a props schema; the browser loader holds
 * the matching module map. SSR comes from the shared Vite SSR bundle.
 */
export const islands = new IslandRegistry(
  [
    {
      id: 'throughput-chart',
      framework: 'vue',
      strategy: 'visible',
      props: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 80 },
          labels: {
            type: 'array',
            maxItems: 52,
            items: { type: 'string', maxLength: 8 },
          },
          values: {
            type: 'array',
            maxItems: 52,
            items: { type: 'integer', minimum: 0, maximum: 100_000 },
          },
        },
        required: ['title', 'labels', 'values'],
      },
    },
  ],
  {
    renderers: moduleIslandRenderers(
      ['throughput-chart'],
      () => import(pathToFileURL(join(exampleRoot, 'dist/ssr/ssr.js')).href),
    ),
    // A failing renderer degrades to the fallback; the client still mounts it.
    onRenderError: (error, id) =>
      logger.warn(
        `Island ${id} SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
  },
);
