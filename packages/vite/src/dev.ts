import { realpathSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { ViteConfigurationError, ViteUnavailableError } from './errors.js';
import { createSsrRenderer } from './ssr.js';
import type { SsrRenderer, SsrRendererOptions } from './ssr.js';

/** The subset of Vite's `ViteDevServer` this package relies on. */
export interface ViteDevServerLike {
  readonly middlewares: (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
  ssrFixStacktrace(error: Error): void;
  close(): Promise<void>;
}

interface ViteModuleLike {
  createServer(config: Record<string, unknown>): Promise<ViteDevServerLike>;
}

export interface ViteDevOptions {
  /** Absolute Vite project root (where the Vite config lives). */
  readonly root: string;
  /** Config file path, or `false` to use only inline options. Default: Vite's lookup in `root`. */
  readonly configFile?: string | false;
  /**
   * HTTP server that should also carry the HMR WebSocket (pass
   * `app.getHttpServer()`), so no extra port is opened. Default: Vite's own
   * HMR port.
   */
  readonly hmrServer?: Server;
  /** Allow dev mode when `NODE_ENV=production`. Default false. */
  readonly allowInProduction?: boolean;
  /**
   * Loader for the `vite` module. Default `import('vite')`. Override to load
   * Vite from a specific location; it is never imported in production mode.
   */
  readonly loadVite?: () => Promise<unknown>;
}

/** A running Vite dev server in middleware mode plus SSR helpers. */
export interface ViteDevHandle {
  /** Mount with `app.use(handle.middlewares)` before Nest routes match. */
  readonly middlewares: ViteDevServerLike['middlewares'];
  readonly server: ViteDevServerLike;
  /**
   * An SSR renderer that loads `entry` through Vite (`ssrLoadModule`) on every
   * render, so server markup follows edits without restarting Nest.
   */
  ssrRenderer(
    entry: string,
    options?: Omit<SsrRendererOptions, 'load'>,
  ): SsrRenderer;
  close(): Promise<void>;
}

function isViteModule(value: unknown): value is ViteModuleLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { createServer?: unknown }).createServer === 'function'
  );
}

/**
 * Starts Vite in middleware mode (`appType: 'custom'`) for a Nest host. Vite is
 * an optional peer imported only here; a missing install raises
 * `ViteUnavailableError` with remediation instead of a module-resolution
 * crash. Refuses to run with `NODE_ENV=production` unless explicitly allowed.
 */
export async function createViteDevServer(
  options: ViteDevOptions,
): Promise<ViteDevHandle> {
  if (typeof options?.root !== 'string' || !isAbsolute(options.root))
    throw new ViteConfigurationError('Vite dev root must be an absolute path');
  if (
    process.env['NODE_ENV'] === 'production' &&
    options.allowInProduction !== true
  )
    throw new ViteUnavailableError(
      'Vite dev mode is disabled when NODE_ENV=production; build with `vite build` and use manifest mode',
    );
  let loaded: unknown;
  // A non-literal specifier keeps Vite's types (and Vite) out of this package's
  // compile and runtime graph until dev mode is actually requested.
  const specifier = 'vite';
  try {
    loaded = await (
      options.loadVite ?? (() => import(/* @vite-ignore */ specifier))
    )();
  } catch (error) {
    throw new ViteUnavailableError(
      'Vite dev mode requires the optional peer dependency `vite`; install it as a devDependency or use production manifest mode',
      { cause: error },
    );
  }
  if (!isViteModule(loaded))
    throw new ViteUnavailableError(
      'Loaded module is not Vite (no createServer)',
    );
  const server = await loaded.createServer({
    root: canonicalRoot(options.root),
    ...(options.configFile === undefined
      ? {}
      : { configFile: options.configFile }),
    appType: 'custom',
    server: {
      middlewareMode: true,
      ...(options.hmrServer ? { hmr: { server: options.hmrServer } } : {}),
    },
  });
  return {
    middlewares: server.middlewares,
    server,
    ssrRenderer(entry, rendererOptions = {}) {
      return createSsrRenderer({
        ...rendererOptions,
        load: async () => {
          try {
            return await server.ssrLoadModule(entry);
          } catch (error) {
            if (error instanceof Error) server.ssrFixStacktrace(error);
            throw error;
          }
        },
        cache: false,
      });
    },
    close: () => server.close(),
  };
}

/**
 * Vite canonicalizes served files with the native realpath; pass the root in the
 * same form (for example, Windows 8.3 short names expanded) so its fs allow list
 * matches. Falls back to the given path when it cannot be resolved.
 */
function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}
