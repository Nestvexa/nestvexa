export {
  ViteConfigurationError,
  ViteSsrError,
  ViteUnavailableError,
} from './errors.js';
export type { ViteSsrErrorType } from './errors.js';
export { assertNonce, escapeHtml } from './html.js';
export {
  isSafeOutputPath,
  normalizeBase,
  parseViteManifest,
  readViteManifest,
  resolveEntryAssets,
} from './manifest.js';
export type {
  LoadedViteManifest,
  ViteEntryAssets,
  ViteManifest,
  ViteManifestChunk,
} from './manifest.js';
export { renderAssetTags } from './tags.js';
export type { ViteTagOptions } from './tags.js';
export { ViteAssets } from './assets.js';
export type { ViteAppOptions, ViteAssetsOptions } from './assets.js';
export { viteStaticMiddleware } from './static.js';
export type { ViteStaticMiddleware, ViteStaticOptions } from './static.js';
export type {
  ViteInstrumentation,
  ViteSpanAttributes,
} from './instrumentation.js';
export { createSsrRenderer, moduleSsrRenderer } from './ssr.js';
export type { SsrRenderer, SsrRendererOptions, SsrResult } from './ssr.js';
export { isMainModule, startOfficialSsrServer } from './ssr-server.js';
export type { OfficialCreateServer, SsrServerOptions } from './ssr-server.js';
export { createViteDevServer } from './dev.js';
export type {
  ViteDevHandle,
  ViteDevOptions,
  ViteDevServerLike,
} from './dev.js';
export { cspNonce, cspNonceMiddleware, defaultCspDirectives } from './csp.js';
export type { CspDirectives, CspNonceOptions } from './csp.js';
export { viteInertiaRootView } from './inertia.js';
export type { InertiaRootContextLike, ViteRootViewOptions } from './inertia.js';
export { viteViewHelpers } from './views.js';
export type { ViteViewHelperOptions } from './views.js';
