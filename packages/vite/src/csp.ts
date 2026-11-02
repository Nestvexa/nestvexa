import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ViteConfigurationError } from './errors.js';

/** Builds the policy for one response from its nonce. */
export type CspDirectives = (nonce: string) => string;

/**
 * Default policy for Vite production builds: module scripts and preloads by
 * nonce with `'strict-dynamic'` (so code-split chunks imported by a trusted
 * entry load), stylesheets from `'self'` or by nonce (Inertia's progress bar
 * and Vite's dev client inject nonce'd `<style>` elements), no plugins,
 * framing or `<base>` rewriting.
 */
export const defaultCspDirectives: CspDirectives = (nonce) =>
  [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

export interface CspNonceOptions {
  readonly directives?: CspDirectives;
  /** Use `Content-Security-Policy-Report-Only` while rolling out. Default false. */
  readonly reportOnly?: boolean;
  /** Nonce entropy in bytes. Default 16 (128 bits). */
  readonly bytes?: number;
}

const nonces = new WeakMap<object, string>();

/**
 * The nonce generated for this request by `cspNonceMiddleware`, or
 * `undefined`. Accepts the raw Node request, an Express request, or a Fastify
 * request (looked up through its `raw` property).
 */
export function cspNonce(request: object): string | undefined {
  const direct = nonces.get(request);
  if (direct !== undefined) return direct;
  const raw = (request as { raw?: unknown }).raw;
  return typeof raw === 'object' && raw !== null ? nonces.get(raw) : undefined;
}

/**
 * Generates a fresh random nonce per request, remembers it for `cspNonce()`
 * and sets the CSP header. Mount it before every route that renders HTML.
 */
export function cspNonceMiddleware(
  options: CspNonceOptions = {},
): (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void {
  const directives = options.directives ?? defaultCspDirectives;
  const bytes = options.bytes ?? 16;
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64)
    throw new ViteConfigurationError('CSP nonce bytes must be 16–64');
  const header = options.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  return (request, response, next) => {
    const nonce = randomBytes(bytes).toString('base64');
    nonces.set(request, nonce);
    response.setHeader(header, directives(nonce));
    next();
  };
}
