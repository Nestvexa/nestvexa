import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ViteConfigurationError, ViteSsrError } from './errors.js';

/** Markup produced by an SSR entry: protocol `head` elements and `body`. */
export interface SsrResult {
  readonly head: readonly string[];
  readonly body: string;
}

export interface SsrRendererOptions {
  /** Loads the SSR module (a built bundle or a Vite `ssrLoadModule` result). */
  readonly load: () => Promise<Record<string, unknown>>;
  /** Exported render function name. Default `render`. */
  readonly exportName?: string;
  /** Per-render timeout. Default 5000 ms. The render itself cannot be aborted. */
  readonly timeoutMs?: number;
  /** Load the module once and reuse it. Default true. */
  readonly cache?: boolean;
}

/**
 * In-process renderer. Structurally compatible with `@nestvexa/inertia`'s
 * `InertiaSsrRenderer`, so it can be passed as `ssr.renderer` directly.
 */
export interface SsrRenderer {
  render(page: object, pageJson: string): Promise<SsrResult>;
  /** Loads (and caches) the module now, e.g. at bootstrap, to fail fast. */
  load(): Promise<void>;
}

type RenderFunction = (page: unknown) => unknown;

const BIGINT_MARKER = '$bigint';

/** Mirrors `@inertiajs/core`'s `parsePage`: revive `{"$bigint": "…"}` markers. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const marker = record[BIGINT_MARKER];
  if (typeof marker === 'string' && /^-?\d+$/.test(marker))
    return BigInt(marker);
  for (const key of Object.keys(record)) record[key] = revive(record[key]);
  return record;
}

function parsePage(pageJson: string): unknown {
  const page: unknown = JSON.parse(pageJson);
  return typeof page === 'object' &&
    page !== null &&
    (page as { preserveBigIntegers?: unknown }).preserveBigIntegers === true
    ? revive(page)
    : page;
}

function isResult(value: unknown): value is SsrResult {
  if (typeof value !== 'object' || value === null) return false;
  const { head, body } = value as { head?: unknown; body?: unknown };
  return (
    Array.isArray(head) &&
    head.every((item) => typeof item === 'string') &&
    typeof body === 'string'
  );
}

/**
 * Wraps an SSR module's `render(page)` export as an Inertia SSR renderer that
 * runs inside the Nest process. Each render receives a fresh copy parsed from
 * the serialized page (the same bytes the client hydrates from), so a renderer
 * can never mutate server state. Failures are classified as `ViteSsrError`;
 * `@nestvexa/inertia` then applies its `fallback`/`strict` mode.
 */
export function createSsrRenderer(options: SsrRendererOptions): SsrRenderer {
  if (typeof options?.load !== 'function')
    throw new ViteConfigurationError('SSR renderer needs a load function');
  const exportName = options.exportName ?? 'render';
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new ViteConfigurationError('timeoutMs must be a positive integer');
  const cache = options.cache !== false;
  let pending: Promise<RenderFunction> | undefined;
  const resolveRender = async (): Promise<RenderFunction> => {
    let module: Record<string, unknown>;
    try {
      module = await options.load();
    } catch (error) {
      throw new ViteSsrError(
        'component-resolution',
        'SSR module failed to load',
        { cause: error },
      );
    }
    const render = module[exportName];
    if (typeof render !== 'function')
      throw new ViteSsrError(
        'invalid-response',
        `SSR module has no "${exportName}" function export`,
      );
    return render as RenderFunction;
  };
  const renderFunction = (): Promise<RenderFunction> => {
    if (!cache) return resolveRender();
    pending ??= resolveRender().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  return {
    async load() {
      await renderFunction();
    },
    async render(_page, pageJson) {
      const render = await renderFunction();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ViteSsrError('timeout', 'SSR render timed out')),
          timeoutMs,
        );
      });
      let result: unknown;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => render(parsePage(pageJson))),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof ViteSsrError) throw error;
        throw new ViteSsrError('render', 'SSR render failed', {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!isResult(result))
        throw new ViteSsrError(
          'invalid-response',
          'SSR render must return { head: string[], body: string }',
        );
      return { head: [...result.head], body: result.body };
    },
  };
}

/**
 * In-process renderer for a built SSR bundle (`vite build --ssr`), imported
 * from an absolute file path on first use (or on `load()`).
 */
export function moduleSsrRenderer(
  file: string,
  options: Omit<SsrRendererOptions, 'load'> = {},
): SsrRenderer {
  if (typeof file !== 'string' || !isAbsolute(file))
    throw new ViteConfigurationError('SSR bundle path must be absolute');
  const url = pathToFileURL(file).href;
  return createSsrRenderer({
    ...options,
    load: async () => (await import(url)) as Record<string, unknown>,
  });
}
