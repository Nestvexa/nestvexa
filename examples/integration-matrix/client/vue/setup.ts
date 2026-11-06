import { createPageRegistry } from '@nestvexa/vue';
import type { VuePageModule } from '@nestvexa/vue';
import Layout from './Layout.vue';

/** Vue root registry: only this root's pages are resolvable. */
export const pages = createPageRegistry(
  import.meta.glob<VuePageModule>('./pages/*.vue'),
  { base: './pages/', extensions: ['.vue'] },
);

export const layout = (): unknown => Layout;
