// Shared by the browser entry (app.tsx) and the SSR entry (ssr.tsx) so both
// resolve the same pages and layouts — a prerequisite for clean hydration.
import { createPageRegistry } from '@nestvexa/react';
import type { ReactPageModule } from '@nestvexa/react';
import AppLayout from './layouts/AppLayout';
import UsersLayout from './layouts/UsersLayout';

/**
 * The only components the server may name. Lazy globs give each page its own
 * chunk; an unknown component name rejects instead of importing a module path.
 */
export const pages = createPageRegistry(
  import.meta.glob<ReactPageModule>('./pages/**/*.tsx'),
  { base: './pages/', extensions: ['.tsx'] },
);

/** Persistent layouts: users pages nest a section layout inside the app shell. */
export function layout(name: string): unknown {
  return name.startsWith('Users/') ? [AppLayout, UsersLayout] : AppLayout;
}

export function title(text: string): string {
  return text ? `${text} · Nestvexa React` : 'Nestvexa React';
}
