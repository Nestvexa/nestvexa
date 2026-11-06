import { createReadStream, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { ViteConfigurationError } from './errors.js';
import { isViteInstrumentation, startSpan } from './instrumentation.js';
import type { ViteInstrumentation } from './instrumentation.js';

export interface ViteStaticOptions {
  /** Absolute build output directory (Vite `build.outDir`, e.g. `dist/client`). */
  readonly root: string;
  /** URL prefix the files are served under; must equal the Vite `base`. Default `/`. */
  readonly prefix?: string;
  /**
   * Files whose path matches get `Cache-Control: public, max-age=31536000,
   * immutable`. Default: a Vite content hash before the extension
   * (`app-B9xk2Q_a.js`). Everything else is served with `no-cache`.
   */
  readonly immutable?: RegExp;
  /** Serve `*.map` files. Default false (keep source maps off public hosts). */
  readonly sourceMaps?: boolean;
  /** Maximum indexed files. Default 10 000. */
  readonly maxFiles?: number;
  /**
   * Optional tracing hook (for example from @nestvexa/observability):
   * `nestvexa.asset.serve` for each request under the prefix, with the
   * content type, bytes, status, cache flags and whether the file exists.
   */
  readonly instrumentation?: ViteInstrumentation;
}

/** Connect/Express/middie-compatible middleware over raw Node objects. */
export type ViteStaticMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

interface IndexedFile {
  readonly path: string;
  readonly size: number;
  readonly etag: string;
  readonly type: string;
  readonly immutable: boolean;
}

const types: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const defaultImmutable = /[.-][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

function normalizePrefix(prefix: string): string {
  if (
    typeof prefix !== 'string' ||
    !prefix.startsWith('/') ||
    !prefix.endsWith('/') ||
    prefix.startsWith('//') ||
    /[\\\s?#%]/.test(prefix)
  )
    throw new ViteConfigurationError(
      'Static prefix must be a plain path starting and ending with "/"',
    );
  return prefix;
}

/**
 * Walks `root` once and records regular files. Dot-files/directories (for
 * example `.vite/manifest.json`) and symbolic links are skipped, so nothing
 * outside the fixed directory can ever be indexed.
 */
function indexDirectory(
  root: string,
  immutable: RegExp,
  sourceMaps: boolean,
  maxFiles: number,
): ReadonlyMap<string, IndexedFile> {
  const files = new Map<string, IndexedFile>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path, `${relative}/`);
      else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (extension === '.map' && !sourceMaps) continue;
        if (files.size >= maxFiles)
          throw new ViteConfigurationError(
            `Static root ${root} has more than ${maxFiles} files`,
          );
        const stat = statSync(path);
        files.set(relative, {
          path,
          size: stat.size,
          etag: `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
          type: types[extension] ?? 'application/octet-stream',
          immutable: immutable.test(relative),
        });
      }
    }
  };
  walk(root, '');
  return files;
}

function requestPath(request: IncomingMessage): string {
  const original = (request as { originalUrl?: unknown }).originalUrl;
  const raw = typeof original === 'string' ? original : (request.url ?? '/');
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
}

/**
 * Serves a Vite build directory from an in-memory index built at startup.
 * Request paths are looked up in that index only — they are never joined onto
 * a filesystem path — so traversal (`..`, encoded separators, backslashes,
 * NUL bytes, drive letters) cannot escape `root`. Unknown paths fall through to
 * `next()`; malformed encodings get `400`. Only `GET`/`HEAD` are handled.
 */
export function viteStaticMiddleware(
  options: ViteStaticOptions,
): ViteStaticMiddleware {
  if (typeof options?.root !== 'string' || !isAbsolute(options.root))
    throw new ViteConfigurationError('Static root must be an absolute path');
  const root = resolve(options.root);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch (error) {
    throw new ViteConfigurationError(
      `Static root ${root} does not exist; run \`vite build\` first`,
      { cause: error },
    );
  }
  if (!isDirectory)
    throw new ViteConfigurationError(`Static root ${root} is not a directory`);
  const prefix = normalizePrefix(options.prefix ?? '/');
  if (
    options.instrumentation !== undefined &&
    !isViteInstrumentation(options.instrumentation)
  )
    throw new ViteConfigurationError(
      'Static instrumentation must have a start() method',
    );
  const instrumentation = options.instrumentation;
  const files = indexDirectory(
    root,
    options.immutable ?? defaultImmutable,
    options.sourceMaps === true,
    options.maxFiles ?? 10_000,
  );
  return (request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    const path = requestPath(request);
    if (!path.startsWith(prefix)) return next();
    let relative: string;
    try {
      relative = decodeURIComponent(path.slice(prefix.length));
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
    const file = files.get(relative);
    const span = startSpan(instrumentation, 'nestvexa.asset.serve', {
      'nestvexa.asset.method': request.method === 'HEAD' ? 'HEAD' : 'GET',
      'nestvexa.asset.hit': file !== undefined,
    });
    if (!file) {
      // Not an asset of this build: the next handler (often a 404) owns it.
      span.end('ok');
      return next();
    }
    const served = (status: number, bytes: number) =>
      span.end('ok', {
        status,
        'nestvexa.asset.type': file.type,
        'nestvexa.asset.bytes': bytes,
        'nestvexa.asset.immutable': file.immutable,
      });
    response.setHeader('Content-Type', file.type);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Cache-Control',
      file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    response.setHeader('ETag', file.etag);
    const match = request.headers['if-none-match'];
    if (
      typeof match === 'string' &&
      match.split(',').some((tag) => tag.trim() === file.etag)
    ) {
      response.statusCode = 304;
      response.end();
      served(304, 0);
      return;
    }
    response.setHeader('Content-Length', String(file.size));
    response.statusCode = 200;
    if (request.method === 'HEAD') {
      response.end();
      served(200, 0);
      return;
    }
    const stream = createReadStream(file.path);
    stream.once('end', () => served(200, file.size));
    stream.on('error', (error) => {
      span.end('error', { status: 500 });
      if (!response.headersSent) next(error);
      else response.destroy(error);
    });
    stream.pipe(response);
  };
}
