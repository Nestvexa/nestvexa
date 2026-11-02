import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ViteConfigurationError } from './errors.js';

export interface SsrServerOptions {
  /** Port. Default 13714 (the upstream default). */
  readonly port?: number;
  /**
   * Bind address. Default `127.0.0.1` — unlike upstream's `0.0.0.0` — because
   * the official server exposes unauthenticated `/render` and `/shutdown`
   * endpoints that must never be reachable from outside the host.
   */
  readonly host?: string;
  /** Fork one worker per CPU (upstream `cluster`). Default false. */
  readonly cluster?: boolean;
  /** Upstream console error formatting. Default true. */
  readonly formatErrors?: boolean;
}

/** The official `@inertiajs/*\/server` default export. */
export type OfficialCreateServer<TRender> = (
  render: TRender,
  options: {
    port: number;
    host: string;
    cluster: boolean;
    formatErrors: boolean;
  },
) => unknown;

/**
 * Starts the official Inertia SSR HTTP server (`POST /render`, `GET /health`)
 * with loopback-only defaults. Pair it with `HttpSsrGateway` from
 * `@nestvexa/inertia` in the Nest process.
 */
export function startOfficialSsrServer<TRender>(
  createServer: OfficialCreateServer<TRender>,
  render: TRender,
  options: SsrServerOptions = {},
): void {
  const port = options.port ?? 13714;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ViteConfigurationError('SSR server port must be 1–65535');
  createServer(render, {
    port,
    host: options.host ?? '127.0.0.1',
    cluster: options.cluster === true,
    formatErrors: options.formatErrors !== false,
  });
}

/**
 * True when the module with this `import.meta.url` is the process entry
 * (`node dist/ssr/ssr.js`), so one SSR bundle can both export `render` for
 * in-process use and start the HTTP server when run directly.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(resolve(entry))).href === importMetaUrl;
  } catch {
    return false;
  }
}
