import { ViteConfigurationError } from './errors.js';
import {
  isSafeOutputPath,
  normalizeBase,
  readViteManifest,
  resolveEntryAssets,
} from './manifest.js';
import type { LoadedViteManifest, ViteEntryAssets } from './manifest.js';
import { renderAssetTags } from './tags.js';
import type { ViteTagOptions } from './tags.js';

/** Assets of one frontend root (one Vite build with its own manifest). */
export interface ViteAppOptions {
  /** Entry modules as manifest keys, relative to the Vite root (`client/app.tsx`). */
  readonly entries: readonly string[];
  /** Absolute path of `.vite/manifest.json` (production mode). */
  readonly manifest?: string;
  /** The Vite `base` the build used. Default `/`. */
  readonly base?: string;
  /** `crossorigin` for module tags (set it for a CDN `base`). */
  readonly crossOrigin?: 'anonymous' | 'use-credentials';
}

export interface ViteAssetsOptions {
  /** Named roots, for example `{ react: {...}, vue: {...} }`. */
  readonly apps: Readonly<Record<string, ViteAppOptions>>;
  /**
   * `production` (default) reads every manifest at construction and fails
   * fast if one is missing. `development` emits dev-server URLs (`@vite/client`
   * plus the raw entry) and needs no manifest.
   */
  readonly mode?: 'production' | 'development';
  /** Dev server origin, e.g. `http://localhost:5173`. Default: same origin (middleware mode). */
  readonly devOrigin?: string;
}

interface ResolvedViteApp {
  readonly key: string;
  readonly entries: readonly string[];
  readonly base: string;
  readonly crossOrigin: 'anonymous' | 'use-credentials' | undefined;
  readonly loaded: LoadedViteManifest | undefined;
  readonly assets: ViteEntryAssets;
}

const keyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function devOrigin(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ViteConfigurationError('devOrigin must be an http(s) origin', {
      cause: error,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ViteConfigurationError('devOrigin must be an http(s) origin');
  return url.origin;
}

/**
 * Per-app Vite asset lookup for Nest hosts. Production mode resolves entry
 * scripts, CSS and module preloads from each app's manifest once at startup
 * (no request ever touches the filesystem); development mode points at the
 * Vite dev server for HMR. Vite itself is never imported here.
 */
export class ViteAssets {
  readonly mode: 'production' | 'development';
  readonly #apps = new Map<string, ResolvedViteApp>();

  constructor(options: ViteAssetsOptions) {
    if (typeof options !== 'object' || options === null)
      throw new ViteConfigurationError('ViteAssets options are required');
    this.mode = options.mode ?? 'production';
    if (this.mode !== 'production' && this.mode !== 'development')
      throw new ViteConfigurationError(
        'mode must be production or development',
      );
    const origin = devOrigin(options.devOrigin);
    const apps = Object.entries(options.apps ?? {});
    if (!apps.length)
      throw new ViteConfigurationError('ViteAssets needs at least one app');
    for (const [key, app] of apps) {
      if (!keyPattern.test(key) || key === '__proto__')
        throw new ViteConfigurationError(`Invalid Vite app key ${key}`);
      const entries = [...(app.entries ?? [])];
      if (!entries.length || !entries.every(isSafeOutputPath))
        throw new ViteConfigurationError(
          `Vite app ${key} needs safe relative entries`,
        );
      const base = normalizeBase(app.base ?? '/');
      let loaded: LoadedViteManifest | undefined;
      let assets: ViteEntryAssets;
      if (this.mode === 'production') {
        if (typeof app.manifest !== 'string')
          throw new ViteConfigurationError(
            `Vite app ${key} needs a manifest path in production mode`,
          );
        loaded = readViteManifest(app.manifest);
        assets = resolveEntryAssets(loaded.manifest, entries, base);
      } else {
        const prefix = origin + base;
        assets = Object.freeze({
          scripts: Object.freeze([
            `${prefix}@vite/client`,
            ...entries.map((entry) => prefix + entry),
          ]),
          styles: Object.freeze([]),
          preloads: Object.freeze([]),
        });
      }
      this.#apps.set(
        key,
        Object.freeze({
          key,
          entries: Object.freeze(entries),
          base,
          crossOrigin: app.crossOrigin,
          loaded,
          assets,
        }),
      );
    }
  }

  /** Configured app keys. */
  get apps(): readonly string[] {
    return [...this.#apps.keys()];
  }

  /** Entry scripts, styles and preloads for `app`. */
  entry(app: string): ViteEntryAssets {
    return this.#app(app).assets;
  }

  /** Escaped `<head>` tags for `app`, with an optional per-request nonce. */
  tags(app: string, options: Pick<ViteTagOptions, 'nonce'> = {}): string {
    const resolved = this.#app(app);
    return renderAssetTags(resolved.assets, {
      nonce: options.nonce,
      crossOrigin: resolved.crossOrigin,
    });
  }

  /**
   * Content version for `app`: the manifest hash in production (changes with
   * every rebuild, so it suits the Inertia asset version), `dev` otherwise.
   */
  version(app: string): string {
    return this.#app(app).loaded?.hash ?? 'dev';
  }

  /** Absolute manifest path for `app` (production mode). */
  manifestPath(app: string): string | undefined {
    return this.#app(app).loaded?.path;
  }

  #app(key: string): ResolvedViteApp {
    const app = this.#apps.get(key);
    if (!app) throw new ViteConfigurationError(`Unknown Vite app "${key}"`);
    return app;
  }
}
