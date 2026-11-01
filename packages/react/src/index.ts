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
export { DefaultErrorFallback, ErrorBoundary } from './boundary.js';
export type { ErrorBoundaryProps, ErrorFallback } from './boundary.js';
export { createReactPageResolver } from './pages.js';
export type { PageProps, ReactPageModule } from './pages.js';
export { metaNonce, mountReactInertiaApp } from './client.js';
export type {
  ReactErrorKind,
  ReactInertiaAppHandle,
  ReactInertiaAppOptions,
} from './client.js';
