/** Invalid configuration, manifest or asset reference. Raised at startup. */
export class ViteConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ViteConfigurationError';
  }
}

/**
 * Vite (an optional peer) was required but cannot be loaded, or dev mode was
 * requested in production. Production manifest mode never needs Vite.
 */
export class ViteUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ViteUnavailableError';
  }
}

/** Classification shared with the `@nestvexa/inertia` SSR error contract. */
export type ViteSsrErrorType =
  'component-resolution' | 'render' | 'invalid-response' | 'timeout';

/** A failed in-process SSR render. Detail is for server logs only. */
export class ViteSsrError extends Error {
  constructor(
    readonly type: ViteSsrErrorType,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ViteSsrError';
  }
}
