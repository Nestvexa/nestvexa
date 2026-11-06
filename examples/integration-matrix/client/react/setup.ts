import { createPageRegistry } from '@nestvexa/react';
import type { ReactPageModule } from '@nestvexa/react';
import Layout from './Layout';

/** React root registry: only this root's pages are resolvable. */
export const pages = createPageRegistry(
  import.meta.glob<ReactPageModule>('./pages/*.tsx'),
  { base: './pages/', extensions: ['.tsx'] },
);

export const layout = (): unknown => Layout;
