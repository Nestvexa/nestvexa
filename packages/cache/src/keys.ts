import { createHash } from 'node:crypto';

/**
 * Who may see a cached value.
 *
 * - `public`: identical for every visitor of every tenant;
 * - `tenant`: shared by the users of one tenant, never personal;
 * - `private`: bound to one identity binding (and tenant) in the key.
 */
export type CacheScope =
  | { readonly kind: 'public' }
  | { readonly kind: 'tenant'; readonly tenant: string }
  | {
      readonly kind: 'private';
      readonly binding: string;
      readonly tenant?: string;
    };
export type CacheVaryValue = string | number | boolean | null;
export interface CacheKeyParts {
  readonly scope: CacheScope;
  /** Logical namespace, for example `render:project-board` or `data:orders`. */
  readonly namespace: string;
  /** Renderer, locale, permission set, asset version, revision… anything output depends on. */
  readonly vary?: Readonly<Record<string, CacheVaryValue>>;
}
export const namespacePattern = /^[a-z][a-z0-9:._-]{0,127}$/;
export const tagPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const varyNamePattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}
function assertTenant(tenant: unknown): string {
  if (typeof tenant !== 'string' || !namespacePattern.test(tenant))
    throw new Error('Invalid cache tenant');
  return tenant;
}
function scopeSegment(scope: CacheScope): string {
  switch (scope.kind) {
    case 'public':
      return 'public';
    case 'tenant':
      return 'tenant:' + digest(`tenant\n${assertTenant(scope.tenant)}`);
    case 'private': {
      const { binding, tenant } = scope;
      if (
        typeof binding !== 'string' ||
        binding.length < 16 ||
        binding.length > 1024
      )
        throw new Error('Private cache entries require an identity binding');
      // UTF-8 hashing replaces every unpaired surrogate with U+FFFD, so
      // such bindings would share a key with each other and with a
      // binding containing a literal U+FFFD.
      if (/\p{Cs}/u.test(binding))
        throw new Error('Cache identity bindings must be well-formed Unicode');
      if (tenant !== undefined) assertTenant(tenant);
      return 'private:' + digest(`${tenant ?? ''}\n${binding}`);
    }
    default:
      throw new Error('Invalid cache scope');
  }
}
/** Canonical `name=value&…` text of vary inputs (sorted by name). */
export function canonicalVary(
  vary: Readonly<Record<string, CacheVaryValue>> | undefined,
): string {
  return Object.entries(vary ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => {
      if (!varyNamePattern.test(name))
        throw new Error('Invalid cache vary name');
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))
      )
        throw new Error('Invalid cache vary value');
      return `${name}=${JSON.stringify(value)}`;
    })
    .join('&');
}

/**
 * Deterministic key. Tenant and private scopes include a SHA-256 of the tenant
 * (and identity binding), so a value can never be read through another
 * tenant's or identity's key; raw bindings never appear in keys.
 */
export function cacheKey(parts: CacheKeyParts): string {
  if (!namespacePattern.test(parts.namespace))
    throw new Error('Invalid cache namespace');
  const scope = scopeSegment(parts.scope);
  return `${parts.namespace}|${scope}|${digest(canonicalVary(parts.vary))}`;
}
