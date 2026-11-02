import { ViteConfigurationError } from './errors.js';

const entities: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? '');
}

/** Renders a double-quoted, escaped attribute value. */
export function attribute(value: string): string {
  return `"${escapeHtml(value)}"`;
}

const noncePattern = /^[A-Za-z0-9+/_-]{8,256}={0,2}$/;

/**
 * Validates a CSP nonce (base64 or base64url, 8–256 characters). Nonces are
 * escaped anyway; validation rejects values that could never match a CSP
 * `'nonce-…'` source and surfaces host bugs early.
 */
export function assertNonce(nonce: string): string {
  if (typeof nonce !== 'string' || !noncePattern.test(nonce))
    throw new ViteConfigurationError('Invalid CSP nonce');
  return nonce;
}
