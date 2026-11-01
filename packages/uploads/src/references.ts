import { fail } from './errors.js';

/** Temporary upload reference returned to the browser: `nvu_` + 256 random bits. */
export const UPLOAD_TOKEN_PATTERN = /^nvu_[A-Za-z0-9_-]{43}$/;
/** Resumable session identifier: `nvs_` + 256 random bits. */
export const UPLOAD_SESSION_PATTERN = /^nvs_[A-Za-z0-9_-]{43}$/;

export function isUploadToken(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_TOKEN_PATTERN.test(value);
}

/**
 * Parse a Live field value: `''`, one token, or comma-separated unique tokens.
 * Shape validation only — finalization still verifies identity, purpose,
 * expiry, size and hash on the server.
 */
export function parseUploadReferences(
  value: unknown,
  max = 10,
): readonly string[] {
  if (!Number.isSafeInteger(max) || max < 1 || max > 100)
    throw new Error('Upload reference limit must be 1–100');
  if (value === '' || value === undefined || value === null)
    return Object.freeze([]);
  if (typeof value !== 'string' || value.length > max * 48)
    fail(400, 'INVALID_UPLOAD_TOKEN');
  const tokens = value.split(',');
  if (
    tokens.length > max ||
    new Set(tokens).size !== tokens.length ||
    !tokens.every((token) => UPLOAD_TOKEN_PATTERN.test(token))
  )
    fail(400, 'INVALID_UPLOAD_TOKEN');
  return Object.freeze(tokens);
}

/**
 * Validator for a writable Live `@State` field holding upload references:
 * `@State({ writable: true, validate: uploadReferenceField({ max: 5 }) })`.
 */
export function uploadReferenceField(
  options: { readonly max?: number } = {},
): (value: unknown) => boolean {
  const max = options.max ?? 10;
  if (!Number.isSafeInteger(max) || max < 1 || max > 100)
    throw new Error('Upload reference limit must be 1–100');
  return (value: unknown) => {
    try {
      parseUploadReferences(value, max);
      return true;
    } catch {
      return false;
    }
  };
}
