/**
 * One `Link` entry of a `103 Early Hints` response. Hints are sent before the
 * route handler has run (and before authorization finished), so they must
 * only name public, content-hashed static assets that every response of the
 * route would reference anyway: never per-user or per-tenant URLs.
 */
export interface EarlyHint {
  /** Same-origin path (`/assets/app-1a2b.js`) or an `https:` URL (CDN). */
  readonly href: string;
  readonly rel: 'modulepreload' | 'preload' | 'preconnect';
  /** Required for `preload`. */
  readonly as?: 'script' | 'style' | 'font' | 'image' | 'fetch';
  readonly crossOrigin?: 'anonymous' | 'use-credentials';
}

/** Hints per response; more is never useful and only delays the final response. */
const maxHints = 32;
// No whitespace, controls, quotes, angle brackets, `;` or `,`: each would
// break out of the `<…>; rel=…` grammar of a Link header value.
const pathPattern = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+=:@%/?-]{0,2047}$/;
const httpsPattern =
  /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+=:@%/?-]{0,2047})?$/;
const destinations = new Set(['script', 'style', 'font', 'image', 'fetch']);

function invalid(message: string): never {
  throw new Error(`Invalid early hint: ${message}`);
}

/** Serialize one hint to a Link header value (validated; throws on unsafe input). */
export function formatEarlyHint(hint: EarlyHint): string {
  if (hint === null || typeof hint !== 'object') invalid('not an object');
  const { href, rel, as, crossOrigin } = hint;
  if (
    typeof href !== 'string' ||
    !(pathPattern.test(href) || httpsPattern.test(href))
  )
    invalid('href must be a same-origin path or an https URL');
  if (rel !== 'modulepreload' && rel !== 'preload' && rel !== 'preconnect')
    invalid('rel');
  if (as !== undefined && !destinations.has(as)) invalid('as');
  if (rel === 'preload' && as === undefined) invalid('preload needs as');
  if (rel === 'preconnect' && as !== undefined)
    invalid('preconnect takes no as');
  if (
    crossOrigin !== undefined &&
    crossOrigin !== 'anonymous' &&
    crossOrigin !== 'use-credentials'
  )
    invalid('crossOrigin');
  return [
    `<${href}>`,
    `rel=${rel}`,
    ...(as === undefined ? [] : [`as=${as}`]),
    ...(crossOrigin === undefined
      ? []
      : [
          crossOrigin === 'anonymous'
            ? 'crossorigin'
            : `crossorigin=${crossOrigin}`,
        ]),
  ].join('; ');
}

interface RawRequest {
  readonly httpVersionMajor?: unknown;
  readonly httpVersionMinor?: unknown;
  readonly method?: unknown;
}
interface RawResponse {
  readonly headersSent?: unknown;
  readonly writableEnded?: unknown;
  readonly req?: RawRequest;
  writeEarlyHints?(hints: Record<string, string | string[]>): void;
}

/** Node `ServerResponse` behind an Express response or a Fastify reply. */
function rawResponse(target: unknown): RawResponse | undefined {
  if (target === null || typeof target !== 'object') return undefined;
  if (typeof Reflect.get(target, 'writeEarlyHints') === 'function')
    return target as RawResponse;
  // Fastify replies expose the Node response as `raw`.
  const raw: unknown = Reflect.get(target, 'raw');
  if (
    raw !== null &&
    typeof raw === 'object' &&
    typeof Reflect.get(raw, 'writeEarlyHints') === 'function'
  )
    return raw as RawResponse;
  return undefined;
}

/**
 * Send `103 Early Hints` with `Link` headers for the given hints. Works with
 * an Express response, a Fastify reply or a Node `ServerResponse` (HTTP/1.1
 * and the HTTP/2 compatibility API). Returns whether hints were written. It
 * writes nothing when the list is empty, the final headers were already sent,
 * the request is HTTP/1.0 (which has no informational responses) or the
 * request method is not GET or HEAD. Invalid hints throw before anything is
 * written.
 *
 * Opt-in: call it from the routes that render HTML documents. Some proxies
 * and load balancers drop or mishandle 1xx responses; see the vite guide.
 */
export function sendEarlyHints(
  response: unknown,
  hints: readonly EarlyHint[],
): boolean {
  if (!Array.isArray(hints)) invalid('hints must be an array');
  if (hints.length > maxHints) invalid(`more than ${maxHints} hints`);
  const links = [...new Set(hints.map(formatEarlyHint))];
  const raw = rawResponse(response);
  if (raw === undefined || links.length === 0) return false;
  if (raw.headersSent === true || raw.writableEnded === true) return false;
  const request = raw.req;
  if (request !== undefined) {
    const major = request.httpVersionMajor;
    const minor = request.httpVersionMinor;
    if (
      typeof major === 'number' &&
      typeof minor === 'number' &&
      (major < 1 || (major === 1 && minor < 1))
    )
      return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  }
  raw.writeEarlyHints?.({ link: links });
  return true;
}
