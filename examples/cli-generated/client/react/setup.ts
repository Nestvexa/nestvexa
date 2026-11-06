import { createPageRegistry } from '@nestvexa/react';
import type { ReactPageModule } from '@nestvexa/react';

// Shared by the browser entry and the SSR entry so both resolve the same pages
// (a prerequisite for clean hydration).

/**
 * The only components the server may name for this root. Each page is its own
 * lazily loaded chunk; unknown names reject instead of importing a module path.
 */
export const pages = createPageRegistry(import.meta.glob<ReactPageModule>('./pages/**/*.tsx'), {
  base: './pages/',
  extensions: ['.tsx'],
});

/** Document title of every page of this root. */
export const title = (title: string): string => (title ? `${title} · React` : 'React');
