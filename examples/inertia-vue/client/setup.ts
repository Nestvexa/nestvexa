// Shared by the browser entry (app.ts) and the SSR entry (ssr.ts) so both
// resolve the same pages and layouts — a prerequisite for clean hydration.
import { createPageRegistry } from '@nestvexa/vue';
import type { VuePageModule } from '@nestvexa/vue';
import AppLayout from './layouts/AppLayout.vue';
import UsersLayout from './layouts/UsersLayout.vue';

/**
 * The only components the server may name. Lazy globs give each page its own
 * chunk; an unknown component name rejects instead of importing a module path.
 */
export const pages = createPageRegistry(
  import.meta.glob<VuePageModule>('./pages/**/*.vue'),
  { base: './pages/', extensions: ['.vue'] },
);

/** Persistent layouts: users pages nest a section layout inside the app shell. */
export function layout(name: string): unknown {
  return name.startsWith('Users/') ? [AppLayout, UsersLayout] : AppLayout;
}

export function title(text: string): string {
  return text ? `${text} · Nestvexa Vue` : 'Nestvexa Vue';
}
