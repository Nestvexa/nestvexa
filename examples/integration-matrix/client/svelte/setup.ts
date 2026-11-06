import { createPageRegistry } from '@nestvexa/svelte';
import type { SveltePageModule } from '@nestvexa/svelte';
import Layout from './Layout.svelte';

/** Svelte root registry: only this root's pages are resolvable. */
export const pages = createPageRegistry(
  import.meta.glob<SveltePageModule>('./pages/*.svelte'),
  { base: './pages/', extensions: ['.svelte'] },
);

export const layout = (): unknown => Layout;
