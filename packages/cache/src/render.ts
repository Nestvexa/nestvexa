import { Cache } from './cache.js';
import type { CacheStatus } from './cache.js';
import { cacheKey, canonicalVary } from './keys.js';
import type { CacheKeyParts, CacheScope, CacheVaryValue } from './keys.js';

/**
 * Who the rendered HTML is for. `public`: identical for everyone (of the
 * stated tenant, if any). `tenant`: shared by one tenant's users with the
 * same permission scope, never personal. `private`: one identity's HTML,
 * never stored unless the `RenderCache` was created with `cachePrivate`.
 */
export type RenderAudience = 'public' | 'tenant' | 'private';
/**
 * Everything rendered HTML depends on. Every field is required so a key can
 * never silently omit one: pass `tenant: null` or `permissions: []`
 * explicitly when output really does not depend on them.
 */
export interface RenderCacheContext {
  /** View, template or component name (`a-z`, digits, `.`, `_`, `-`). */
  readonly component: string;
  /** Component or template revision: change it when the template or its data shape changes. */
  readonly revision: string | number;
  /** Renderer id, for example `hbs`, `ejs`, `live`, `inertia-ssr`. */
  readonly renderer: string;
  /** Negotiated locale (BCP 47), resolved server-side. */
  readonly locale: string;
  /** Tenant resolved server-side, or `null` for tenant-independent output. */
  readonly tenant: string | null;
  /** Permission scope the output was rendered for (order-insensitive). */
  readonly permissions: readonly string[];
  /** Deployed asset version (for example the Vite manifest hash). */
  readonly assetVersion: string;
  /** Further inputs the HTML depends on (page number, filters, props hash). */
  readonly vary?: Readonly<Record<string, CacheVaryValue>>;
}
export interface RenderCacheRequest extends RenderCacheContext {
  readonly audience: RenderAudience;
  /** Identity binding; required for `private`, ignored otherwise. */
  readonly binding?: string;
  readonly ttlMs: number;
  /** Public and tenant audiences only. */
  readonly staleWhileRevalidateMs?: number;
  readonly tags?: readonly string[];
}
export interface RenderCacheOptions {
  /**
   * Store private per-user HTML, keyed by identity binding and tenant (no
   * stale-while-revalidate). Default `false`: private renders always run
   * and are never stored.
   */
  readonly cachePrivate?: boolean;
}
export interface RenderResult {
  readonly html: string;
  readonly status: CacheStatus;
}

const componentPattern = /^[a-z][a-z0-9._-]{0,100}$/;
const rendererPattern = /^[a-z][a-z0-9.-]{0,31}$/;
const localePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
const permissionPattern = /^[A-Za-z0-9:._*/-]{1,128}$/;
const assetVersionPattern = /^[A-Za-z0-9._:+-]{1,128}$/;
const tenantPattern = /^[a-z][a-z0-9:._-]{0,127}$/;

function invalid(field: string): never {
  throw new Error(`Invalid render cache ${field}`);
}
/** Validated cache key parts for a render request. */
export function renderCacheParts(request: RenderCacheRequest): CacheKeyParts {
  const {
    audience,
    component,
    revision,
    renderer,
    locale,
    tenant,
    permissions,
    assetVersion,
  } = request;
  if (typeof component !== 'string' || !componentPattern.test(component))
    invalid('component');
  if (
    !(typeof revision === 'number' && Number.isSafeInteger(revision)) &&
    !(typeof revision === 'string' && assetVersionPattern.test(revision))
  )
    invalid('revision');
  if (typeof renderer !== 'string' || !rendererPattern.test(renderer))
    invalid('renderer');
  if (typeof locale !== 'string' || !localePattern.test(locale))
    invalid('locale');
  if (
    tenant !== null &&
    (typeof tenant !== 'string' || !tenantPattern.test(tenant))
  )
    invalid('tenant');
  if (
    !Array.isArray(permissions) ||
    permissions.length > 256 ||
    !permissions.every(
      (permission: unknown) =>
        typeof permission === 'string' && permissionPattern.test(permission),
    )
  )
    invalid('permissions');
  if (
    typeof assetVersion !== 'string' ||
    !assetVersionPattern.test(assetVersion)
  )
    invalid('assetVersion');
  let scope: CacheScope;
  if (audience === 'public') scope = { kind: 'public' };
  else if (audience === 'tenant') {
    if (tenant === null) invalid('tenant (required for the tenant audience)');
    scope = { kind: 'tenant', tenant };
  } else if (audience === 'private') {
    if (typeof request.binding !== 'string') invalid('binding');
    scope = {
      kind: 'private',
      binding: request.binding,
      ...(tenant === null ? {} : { tenant }),
    };
  } else invalid('audience');
  return {
    namespace: `render:${component}`,
    scope,
    vary: {
      revision,
      renderer,
      // Locale tags are case-insensitive: `en-US` and `en-us` share a key.
      locale: locale.toLowerCase(),
      tenant,
      permissions: JSON.stringify([...new Set(permissions)].sort()),
      assetVersion,
      vary: canonicalVary(request.vary),
    },
  };
}
/** The key a render request maps to (for diagnostics and tests). */
export function renderCacheKey(request: RenderCacheRequest): string {
  return cacheKey(renderCacheParts(request));
}

/**
 * Rendered-HTML cache on top of `Cache`. Keys always include component,
 * revision, renderer, locale, tenant, permission scope and asset version.
 * Private per-user HTML is never stored unless `cachePrivate` is set, HTML
 * containing Live snapshots, CSRF tokens or signed island props is refused
 * (`CacheRefusedError`), and stale-while-revalidate is limited to the public
 * and tenant audiences.
 */
export class RenderCache {
  readonly #cachePrivate: boolean;
  constructor(
    readonly cache: Cache = new Cache(),
    options: RenderCacheOptions = {},
  ) {
    this.#cachePrivate = options.cachePrivate === true;
  }
  async render(
    request: RenderCacheRequest,
    render: () => string | Promise<string>,
  ): Promise<RenderResult> {
    const parts = renderCacheParts(request);
    const produce = async () => {
      const html: unknown = await render();
      if (typeof html !== 'string')
        throw new Error('Render cache renderers must return an HTML string');
      return html;
    };
    if (request.audience === 'private' && !this.#cachePrivate) {
      this.cache.metrics.bypassed++;
      this.cache.emit({
        type: 'bypass',
        namespace: parts.namespace,
        scope: 'private',
        reason: 'private-html',
      });
      return { html: await produce(), status: 'bypass' };
    }
    const result = await this.cache.lookup(
      parts,
      {
        ttlMs: request.ttlMs,
        ...(request.staleWhileRevalidateMs === undefined
          ? {}
          : { staleWhileRevalidateMs: request.staleWhileRevalidateMs }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
      },
      produce,
    );
    if (typeof result.value !== 'string')
      throw new Error('Render cache entry is not HTML');
    return { html: result.value, status: result.status };
  }
  /** Invalidate rendered fragments (and data) carrying any of the tags. */
  invalidate(tags: readonly string[]): Promise<number> {
    return this.cache.invalidate(tags);
  }
}
