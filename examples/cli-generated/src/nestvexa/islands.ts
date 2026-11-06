import { IslandRegistry } from '@nestvexa/islands';

/**
 * Server-side island allowlist; client/islands/index.ts holds the matching
 * build-time module map. `nestvexa make:island` appends to both.
 * Render with `islands.render('<id>', props, { key, label, fallback })`.
 */
export const islands = new IslandRegistry([
  { id: 'clicker', framework: 'react' },
  // nestvexa:islands
]);
