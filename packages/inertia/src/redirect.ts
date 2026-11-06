import { InertiaConfigurationError, InertiaRedirectError } from './errors.js';
import { hasControlCharacter } from './text.js';

export interface RedirectPolicy {
  /** Exact origins (scheme://host[:port]) absolute targets may use. */
  readonly allowedOrigins: ReadonlySet<string>;
}

const unsafe = (value: string): boolean =>
  hasControlCharacter(value) || value.includes('\\');

/** Normalizes an allowlisted origin, rejecting anything that is not http(s). */
export function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new InertiaConfigurationError(`Invalid redirect origin`, {
      cause: error,
    });
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.origin !== origin.replace(/\/$/, '')
  )
    throw new InertiaConfigurationError(
      `Redirect origin must be a bare http(s) origin`,
    );
  return url.origin;
}

/**
 * Returns the target unchanged when it is safe to emit in `Location`,
 * `X-Inertia-Location` or `X-Inertia-Redirect`:
 *
 * - same-application relative paths starting with exactly one `/`
 *   (`//host`, `/\host` and backslashes anywhere are rejected); or
 * - absolute `http(s)` URLs whose origin is explicitly allowlisted.
 *
 * Control characters (header injection), credentials in URLs, scheme-relative
 * and non-http schemes (`javascript:`, `data:`) are always rejected.
 */
export function assertSafeRedirect(
  target: unknown,
  policy: RedirectPolicy,
): string {
  if (typeof target !== 'string' || target.length === 0 || target.length > 2048)
    throw new InertiaRedirectError();
  if (unsafe(target) || target.trim() !== target)
    throw new InertiaRedirectError();
  if (target.startsWith('/')) {
    if (target.startsWith('//')) throw new InertiaRedirectError();
    return target;
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new InertiaRedirectError();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !policy.allowedOrigins.has(url.origin)
  )
    throw new InertiaRedirectError();
  return target;
}

/**
 * Converts a `Referer` into a relative same-host path for `back()`. Returns
 * undefined when the referer is missing, malformed, cross-host or unsafe, so
 * callers fall back to a configured path instead of following it. The result
 * is always relative, so a spoofed `Host` header cannot turn it into an
 * off-site redirect.
 */
export function refererPath(
  referer: string | undefined,
  host: string | undefined,
  policy: RedirectPolicy,
): string | undefined {
  if (!referer || referer.length > 2048 || unsafe(referer)) return undefined;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  const sameHost = host !== undefined && url.host === host.toLowerCase();
  if (!sameHost)
    return policy.allowedOrigins.has(url.origin) ? url.href : undefined;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith('//') ? undefined : path;
}

/** Collapses leading slashes so a raw request URL can never be scheme-relative. */
export function relativeRequestUrl(raw: string): string {
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return path.replace(/^\/{2,}/, '/');
}

/**
 * Accepts a stored previous URL only when it is a same-application relative
 * path (one leading `/`, no backslashes or control characters, at most 2048
 * characters). Session contents are host-persisted data, so anything else is
 * ignored rather than redirected to.
 */
export function storablePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    unsafe(value) ||
    value.trim() !== value
  )
    return undefined;
  return value;
}
