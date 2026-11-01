import { DANGEROUS_EXTENSIONS } from './file-types.js';
import { fail } from './errors.js';

export interface ParsedFilename {
  /** NFC display name, kept only as metadata; never used as a storage path. */
  readonly name: string;
  /** Lower-case final extension without the dot. */
  readonly extension: string;
}

const bidiOrInvisible =
  /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const reserved = /[/\\:*?"<>|]/;

/**
 * Validate a client-supplied filename. Path separators, traversal segments,
 * control/bidi characters, hidden names and dangerous inner extensions are
 * refused rather than silently rewritten, so users see an honest error.
 */
export function parseClientFilename(raw: unknown): ParsedFilename {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024)
    fail(400, 'INVALID_FILENAME');
  const name = raw.normalize('NFC');
  if (
    reserved.test(name) ||
    bidiOrInvisible.test(name) ||
    [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    }) ||
    name !== name.trim() ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    Buffer.byteLength(name) > 255
  )
    fail(400, 'INVALID_FILENAME');
  const segments = name.split('.');
  const last = segments.at(-1);
  if (segments.length < 2 || !last || !segments[0])
    fail(400, 'MISSING_EXTENSION');
  const extension = last.toLowerCase();
  if (
    segments
      .slice(1)
      .some((segment) => DANGEROUS_EXTENSIONS.has(segment.trim().toLowerCase()))
  )
    fail(400, 'DANGEROUS_EXTENSION');
  return Object.freeze({ name, extension });
}

/** Decode the percent-encoded UTF-8 name header used by the JavaScript upload routes. */
export function decodeFilenameHeader(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 3072)
    fail(400, 'INVALID_FILENAME');
  try {
    return decodeURIComponent(value);
  } catch {
    return fail(400, 'INVALID_FILENAME');
  }
}

/** RFC 5987 `attr-char` encoding: encodeURIComponent leaves `'()*!` unescaped. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a Content-Disposition header (RFC 6266) with an ASCII fallback and an
 * RFC 5987 UTF-8 `filename*`. Header-breaking and quoting characters cannot
 * survive into the fallback.
 */
export function contentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const cleaned = [...String(filename).normalize('NFC')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join('')
    .replace(new RegExp(bidiOrInvisible.source, 'gu'), '')
    .replace(/[/\\]/g, '_')
    .slice(0, 255);
  const safe = cleaned.trim() || 'download';
  const fallback =
    safe.replace(/[^\x20-\x7e]|["\\%;]/g, '_').slice(0, 180) || 'download';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}
