import { SafeHtml } from '@nestvexa/views';
import type { ViewEngineAdapter, ViewModel } from '@nestvexa/views';
import type { CacheStatus } from './cache.js';
import type { CacheVaryValue } from './keys.js';
import { RenderCache } from './render.js';
import type { RenderAudience } from './render.js';

/**
 * The part of a view engine a fragment cache needs. `HbsEngine` and every
 * other `ViewEngineAdapter` match it structurally.
 */
export type FragmentEngine = Pick<ViewEngineAdapter, 'name' | 'render'>;

export interface FragmentCacheOptions {
  /** Engine that renders fragment templates (for example the app's `HbsEngine`). */
  readonly engine: FragmentEngine;
  /**
   * Deployed asset version (for example the Vite manifest hash), or a
   * function returning the current one. Part of every key.
   */
  readonly assetVersion: string | (() => string);
  /** Shared render cache. Default: a new in-memory `RenderCache`. */
  readonly renders?: RenderCache;
  /** Renderer id in the key. Default: the engine `name` (`hbs`). */
  readonly renderer?: string;
}

/**
 * One cached fragment. Scope (`audience`) and key inputs are explicit: the
 * key is built only from `key`, `revision`, the renderer, `locale`,
 * `tenant`, `permissions`, the asset version and `vary`. It never looks at
 * the page model, so everything the fragment depends on must be named here.
 */
export interface FragmentRequest {
  /** Explicit fragment key (`a-z`, digits, `.`, `_`, `-`), for example `catalog.sidebar`. */
  readonly key: string;
  /** Template the fragment renders, without a layout. */
  readonly view: string;
  /** Change it when the template or the shape of its model changes. */
  readonly revision: string | number;
  /**
   * Who the HTML is for. `private` (personal) fragments are rendered on
   * every request and never stored, unless the `RenderCache` was created
   * with `cachePrivate`.
   */
  readonly audience: RenderAudience;
  /** Negotiated locale, resolved server-side. */
  readonly locale: string;
  /** Tenant resolved server-side, or `null` for tenant-independent output. */
  readonly tenant: string | null;
  /** Permission scope the fragment is rendered for (order-insensitive). */
  readonly permissions: readonly string[];
  /** Further inputs the HTML depends on (page number, filters). */
  readonly vary?: Readonly<Record<string, CacheVaryValue>>;
  /** Identity binding; required for `private`. */
  readonly binding?: string;
  readonly ttlMs: number;
  /** Public and tenant audiences only. */
  readonly staleWhileRevalidateMs?: number;
  /** Data tags; `invalidate(tags)` drops the fragment after a write. */
  readonly tags?: readonly string[];
  /**
   * Loads the fragment's own model. Called only when the fragment is
   * rendered (miss, refresh or bypass), so a hit skips the data load. The
   * template sees this model only, never the page model.
   */
  readonly model: () => ViewModel | Promise<ViewModel>;
}

export interface FragmentResult {
  /** Trusted fragment HTML; put it in a view model and print it with `{{name}}`. */
  readonly html: SafeHtml;
  readonly status: CacheStatus;
}
export interface FragmentSet<Name extends string> {
  readonly html: Readonly<Record<Name, SafeHtml>>;
  readonly status: Readonly<Record<Name, CacheStatus>>;
}

const keyPattern = /^[a-z][a-z0-9._-]{0,90}$/;

/**
 * Read-through cache for server-rendered view fragments (HBS partial
 * templates and other `ViewEngineAdapter` views) on top of `RenderCache`.
 * Rendering stays asynchronous and outside the template: the controller (or
 * a view composer) awaits `render()` and passes the `SafeHtml` result to
 * the page. Inherits every `RenderCache` rule: required key context, no
 * storage of private HTML by default, refusal of Live snapshots, CSRF tokens
 * and signed island props, tag invalidation and single flight per key.
 */
export class FragmentCache {
  readonly renders: RenderCache;
  readonly #engine: FragmentEngine;
  readonly #assetVersion: () => string;
  readonly #renderer: string;
  constructor(options: FragmentCacheOptions) {
    if (typeof options.engine?.render !== 'function')
      throw new Error('Fragment cache needs a view engine with render()');
    const version = options.assetVersion;
    if (typeof version !== 'string' && typeof version !== 'function')
      throw new Error('Fragment cache needs an asset version');
    this.#engine = options.engine;
    this.#assetVersion =
      typeof version === 'string' ? () => version : () => version();
    this.#renderer = options.renderer ?? options.engine.name;
    this.renders = options.renders ?? new RenderCache();
  }
  async render(request: FragmentRequest): Promise<FragmentResult> {
    if (typeof request.key !== 'string' || !keyPattern.test(request.key))
      throw new Error('Invalid fragment key');
    if (typeof request.view !== 'string' || request.view === '')
      throw new Error('Invalid fragment view');
    if (typeof request.model !== 'function')
      throw new Error('Fragment model must be a loader function');
    const { key, view, model, ...context } = request;
    const result = await this.renders.render(
      {
        ...context,
        component: `fragment.${key}`,
        renderer: this.#renderer,
        assetVersion: this.#assetVersion(),
      },
      async () => this.#engine.render(view, await model(), { layout: false }),
    );
    return { html: SafeHtml.trusted(result.html), status: result.status };
  }
  /** Render several fragments concurrently, keyed by the model names to use. */
  async renderAll<Name extends string>(
    requests: Readonly<Record<Name, FragmentRequest>>,
  ): Promise<FragmentSet<Name>> {
    const names = Object.keys(requests) as Name[];
    const results = await Promise.all(
      names.map((name) => this.render(requests[name])),
    );
    const html = {} as Record<Name, SafeHtml>;
    const status = {} as Record<Name, CacheStatus>;
    names.forEach((name, index) => {
      const result = results[index];
      if (result === undefined) return;
      html[name] = result.html;
      status[name] = result.status;
    });
    return { html, status };
  }
  /** Drop fragments (and data) carrying any of the tags. */
  invalidate(tags: readonly string[]): Promise<number> {
    return this.renders.invalidate(tags);
  }
}
