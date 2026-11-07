import { createHash } from 'node:crypto';
import { NestvexaError } from '@nestvexa/core';

/** Route path excludes the host prefix; basePath describes its public prefix. */
export interface NestvexaAssetOptions {
  readonly path?: string;
  readonly basePath?: string;
}
export interface AssetOptions {
  readonly path: string;
  readonly basePath: string;
}
/**
 * The canonical client entry and its on-demand feature chunks (ADR 0035), in
 * package `files` order. The entry imports each chunk by this sibling name;
 * private implementation outputs are not public assets.
 */
export const CLIENT_MODULES = [
  'index.js',
  'live-realtime.js',
  'live-sort.js',
  'live-stream.js',
  'live-upload.js',
] as const;

export interface ClientAsset {
  readonly content: string;
  readonly etag: string;
}
/** Content-addressed URLs for the installed Live client and CSP Alpine distribution. */
export interface ClientAssetManifest {
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
  /** Subresource Integrity (`sha384-…`) of each served file, keyed like `files`. */
  readonly integrity: Readonly<Record<string, string>>;
  readonly entries: {
    readonly live: string;
    readonly alpine: string;
    readonly alpineAdapter: string;
  };
}
export function normalizeAssetOptions(input: unknown): AssetOptions {
  const invalid = (): never => {
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Invalid client asset configuration',
    );
  };
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'path' && key !== 'basePath') return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) return invalid();
  }
  const route: unknown = Object.getOwnPropertyDescriptor(input, 'path')?.value;
  const base: unknown = Object.getOwnPropertyDescriptor(
    input,
    'basePath',
  )?.value;
  const path = route === undefined ? '/_nestvexa/assets' : route;
  const basePath = base === undefined ? '' : base;
  const valid = (value: unknown): value is string =>
    typeof value === 'string' &&
    !/[\r\n]/.test(value) &&
    value.length <= 256 &&
    /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value);
  if (!valid(path) || (basePath !== '' && !valid(basePath))) return invalid();
  return Object.freeze({ path, basePath });
}

/** Hash names and exact served UTF-8 content with explicit length boundaries. */
export function catalogVersion(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const [name, content] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    hash.update(
      `${Buffer.byteLength(name)}:${name}${Buffer.byteLength(content)}:`,
    );
    hash.update(content);
  }
  return hash.digest('hex');
}
/** SRI metadata of the exact served UTF-8 bytes. */
export function assetIntegrity(content: string): string {
  return `sha384-${createHash('sha384').update(content, 'utf8').digest('base64')}`;
}
export function assetTag(content: string): string {
  return `"${createHash('sha256').update(content).digest('hex')}"`;
}
/** If-None-Match uses weak comparison for these GET/HEAD representations. */
export function matchesAssetTag(header: unknown, tag: string): boolean {
  if (typeof header !== 'string' || /[\r\n]/.test(header)) return false;
  if (/^[\t ]*\*[\t ]*$/.test(header)) return true;
  // Commas and asterisks may be literal bytes inside an opaque entity tag.
  // Validate the whole list before matching complete quoted tokens.
  const entityTag = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
  if (
    !new RegExp(
      `^[\\t ]*${entityTag}(?:[\\t ]*,[\\t ]*${entityTag})*[\\t ]*$`,
    ).test(header)
  )
    return false;
  return [...header.matchAll(new RegExp(entityTag, 'g'))].some(
    ([value]) => value === tag || value === `W/${tag}`,
  );
}
