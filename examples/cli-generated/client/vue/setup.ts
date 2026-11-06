import { createPageRegistry } from '@nestvexa/vue';
import type { VuePageModule } from '@nestvexa/vue';

// Shared by the browser entry and the SSR entry so both resolve the same pages
// (a prerequisite for clean hydration).

/**
 * The only components the server may name for this root. Each page is its own
 * lazily loaded chunk; unknown names reject instead of importing a module path.
 */
export const pages = createPageRegistry(import.meta.glob<VuePageModule>('./pages/**/*.vue'), {
  base: './pages/',
  extensions: ['.vue'],
});

/** Document title of every page of this root. */
export const title = (title: string): string => (title ? `${title} · Vue` : 'Vue');
