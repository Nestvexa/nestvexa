export {
  PageNotFoundError,
  PageRegistryError,
  createPageRegistry,
  isPageName,
} from '@nestvexa/vite/pages';
export type {
  PageGlob,
  PageRegistry,
  PageRegistryOptions,
} from '@nestvexa/vite/pages';
export { createSveltePageResolver } from './pages.js';
export type { PageProps, SveltePageModule } from './pages.js';
export { metaNonce, mountSvelteInertiaApp } from './client.js';
export type {
  SvelteCreateInertiaApp,
  SvelteInertiaAppHandle,
  SvelteInertiaAppOptions,
} from './client.js';
