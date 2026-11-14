import { defineExtension, type NestvexaExtension } from '@nestvexa/core';

/**
 * A third-party extension (MAINT-007), built outside the Nestvexa repository
 * against the packed `@nestvexa/core` public API only. It declares a
 * capability, records a diagnostics event when it registers, adds a
 * primitive field to every request context and reports its shutdown.
 */
export interface AuditExtensionOptions {
  /** Value added to each request context as `context.extensions['mini.audit'].tenant`. */
  readonly tenant: string;
  readonly onShutdown?: () => void;
}

export function auditExtension(
  options: AuditExtensionOptions,
): NestvexaExtension {
  return defineExtension({
    name: 'mini.audit',
    version: '1.0.0',
    nestvexa: '^0.1.0-alpha.0',
    capabilities: { 'mini.audit': { supported: true } },
    register(context) {
      context.diagnostics.event('mini.audit.registered', {
        tenant: options.tenant,
      });
    },
    contributeContext: () => ({ tenant: options.tenant }),
    shutdown() {
      options.onShutdown?.();
    },
  });
}
