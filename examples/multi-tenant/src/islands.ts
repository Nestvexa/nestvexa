import { IslandRegistry } from '@nestvexa/islands';
import { randomBytes } from 'node:crypto';
import type { ProjectRepository } from './tenancy.js';

/**
 * Island allowlist. Props are public page data, so they carry counts only; the
 * signature proves the server rendered them, not that the caller may use them.
 */
export const islands = new IslandRegistry(
  [
    {
      id: 'project-stats',
      framework: 'vue',
      strategy: 'visible',
      signed: true,
      props: {
        type: 'object',
        properties: {
          tenant: { type: 'string', maxLength: 40 },
          total: { type: 'integer', minimum: 0, maximum: 1000 },
          done: { type: 'integer', minimum: 0, maximum: 1000 },
        },
        required: ['tenant', 'total', 'done'],
      },
    },
  ],
  { signingKeys: [randomBytes(32)] },
);
export function statsIsland(projects: ProjectRepository, tenant: string) {
  const rows = projects.list(tenant);
  return islands.render(
    'project-stats',
    {
      tenant,
      total: rows.length,
      done: rows.filter((row) => row.status === 'done').length,
    },
    {
      key: 'stats',
      label: 'Project statistics',
      fallback: `${rows.length} projects`,
    },
  );
}
