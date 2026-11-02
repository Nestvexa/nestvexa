// Shared by the browser entry (app.ts) and the SSR entry (ssr.ts) so both
// resolve the same pages and layouts — a prerequisite for clean hydration.
import { createPageRegistry } from '@nestvexa/svelte';
import type { SveltePageModule } from '@nestvexa/svelte';
import AppLayout from './layouts/AppLayout.svelte';
import UsersLayout from './layouts/UsersLayout.svelte';

/**
 * The only components the server may name. Lazy globs give each page its own
 * chunk; an unknown component name rejects instead of importing a module path.
 */
export const pages = createPageRegistry(
  import.meta.glob<SveltePageModule>('./pages/**/*.svelte'),
  { base: './pages/', extensions: ['.svelte'] },
);

/** Persistent layouts: users pages nest a section layout inside the app shell. */
export function layout(name: string): unknown {
  return name.startsWith('Users/') ? [AppLayout, UsersLayout] : AppLayout;
}
