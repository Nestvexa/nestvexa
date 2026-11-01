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
export { ErrorBoundary, defaultErrorFallback } from './boundary.js';
export { createVuePageResolver } from './pages.js';
export type { PageProps, VuePageModule } from './pages.js';
export { metaNonce, mountVueInertiaApp } from './client.js';
export type {
  VueErrorKind,
  VueInertiaAppHandle,
  VueInertiaAppOptions,
} from './client.js';
