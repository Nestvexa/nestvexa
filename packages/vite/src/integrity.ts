import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ViteConfigurationError } from './errors.js';
import { isSafeOutputPath } from './manifest.js';

/** Hash algorithms allowed in `integrity` attributes (W3C SRI). */
export type IntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512';
const algorithms: readonly IntegrityAlgorithm[] = [
  'sha256',
  'sha384',
  'sha512',
];
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const metadata = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/;

export function isIntegrityAlgorithm(
  value: unknown,
): value is IntegrityAlgorithm {
  return algorithms.some((algorithm) => algorithm === value);
}

/** `sha384-<base64>` integrity metadata for exact response bytes. */
export function subresourceIntegrity(
  content: Uint8Array | string,
  algorithm: IntegrityAlgorithm = 'sha384',
): string {
  if (!isIntegrityAlgorithm(algorithm))
    throw new ViteConfigurationError('Unsupported integrity algorithm');
  return `${algorithm}-${createHash(algorithm).update(content).digest('base64')}`;
}

/**
 * Whether `content` matches one of the space-separated integrity metadata
 * entries, as a browser checks it: only the strongest algorithm present
 * counts, and malformed entries are ignored (no valid entry fails closed).
 */
export function verifySubresourceIntegrity(
  content: Uint8Array | string,
  integrity: string,
): boolean {
  if (typeof integrity !== 'string') return false;
  const entries = integrity
    .split(/\s+/)
    .map((token) => metadata.exec(token.split('?')[0] ?? ''))
    .filter((match): match is RegExpExecArray => match !== null);
  if (!entries.length) return false;
  const strongest = algorithms
    .filter((algorithm) => entries.some((entry) => entry[1] === algorithm))
    .at(-1);
  if (strongest === undefined) return false;
  const actual = createHash(strongest).update(content).digest();
  return entries.some((entry) => {
    if (entry[1] !== strongest) return false;
    const expected = Buffer.from(entry[2] ?? '', 'base64');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  });
}

/**
 * Hash each built file under `outDir` once (manifest-read time). Paths come
 * from the validated manifest, never from requests; a missing file fails
 * startup instead of rendering a tag the browser would block.
 */
export function integrityForFiles(
  outDir: string,
  files: readonly string[],
  algorithm: IntegrityAlgorithm,
): ReadonlyMap<string, string> {
  const root = resolve(outDir);
  const result = new Map<string, string>();
  for (const file of files) {
    if (result.has(file)) continue;
    if (!isSafeOutputPath(file))
      throw new ViteConfigurationError('Unsafe asset path for integrity');
    const path = resolve(root, file);
    if (!path.startsWith(root + sep))
      throw new ViteConfigurationError('Unsafe asset path for integrity');
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      throw new ViteConfigurationError(
        `Built asset ${file} is missing under ${root}; cannot compute its integrity`,
        { cause: error },
      );
    }
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new ViteConfigurationError(
        `Built asset ${file} is too large to hash`,
      );
    result.set(file, subresourceIntegrity(bytes, algorithm));
  }
  return result;
}
