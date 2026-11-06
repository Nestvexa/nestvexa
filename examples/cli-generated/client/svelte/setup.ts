import { createPageRegistry } from '@nestvexa/svelte';
import type { SveltePageModule } from '@nestvexa/svelte';

// Shared by the browser entry and the SSR entry so both resolve the same pages
// (a prerequisite for clean hydration).

/**
 * The only components the server may name for this root. Each page is its own
 * lazily loaded chunk; unknown names reject instead of importing a module path.
 */
export const pages = createPageRegistry(import.meta.glob<SveltePageModule>('./pages/**/*.svelte'), {
  base: './pages/',
  extensions: ['.svelte'],
});
