import { createPageRegistry } from '@nestvexa/vue';
import type { VuePageModule } from '@nestvexa/vue';
import Layout from './Layout.vue';

/** Only the pages in this directory are resolvable by the Inertia client. */
export const pages = createPageRegistry(
  import.meta.glob<VuePageModule>('./pages/*.vue'),
  { base: './pages/', extensions: ['.vue'] },
);

export const layout = (): unknown => Layout;
