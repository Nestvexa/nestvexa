import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ViteConfigurationError } from './errors.js';

/** One chunk record of a Vite `build.manifest` file (`.vite/manifest.json`). */
export interface ViteManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

/** A validated Vite manifest keyed by source path relative to the Vite root. */
export type ViteManifest = ReadonlyMap<string, ViteManifestChunk>;

/** Public URLs needed to boot one or more entries. */
export interface ViteEntryAssets {
  /** Entry module scripts (`<script type="module">`). */
  readonly scripts: readonly string[];
  /** Stylesheets of the entries and of their static imports, in order. */
  readonly styles: readonly string[];
  /** Statically imported chunks (`<link rel="modulepreload">`). */
  readonly preloads: readonly string[];
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 20_000;
const segment = /^[A-Za-z0-9_@+~=-][A-Za-z0-9._@+~=-]*$/;

/** True for a relative, normalized output path without traversal or schemes. */
export function isSafeOutputPath(path: string): boolean {
  if (typeof path !== 'string' || path === '' || path.length > 1024)
    return false;
  return path.split('/').every((part) => segment.test(part) && part !== '..');
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string')
  )
    throw new ViteConfigurationError(`Manifest ${label} must be strings`);
  return Object.freeze([...value]);
}

function outputList(value: unknown, label: string): readonly string[] {
  const list = stringList(value, label);
  for (const path of list)
    if (!isSafeOutputPath(path))
      throw new ViteConfigurationError(`Unsafe manifest ${label} path`);
  return list;
}

/**
 * Validates parsed manifest JSON. Every output path must be a normalized
 * relative path, so a tampered manifest cannot emit `javascript:`, absolute or
 * traversal URLs into documents.
 */
export function parseViteManifest(input: unknown): ViteManifest {
  const value: unknown = typeof input === 'string' ? parseJson(input) : input;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ViteConfigurationError('Vite manifest must be a JSON object');
  const entries = Object.entries(value);
  if (entries.length > MAX_CHUNKS)
    throw new ViteConfigurationError('Vite manifest has too many chunks');
  const manifest = new Map<string, ViteManifestChunk>();
  for (const [key, raw] of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new ViteConfigurationError(
        `Manifest chunk ${key} is not an object`,
      );
    const record = raw as Record<string, unknown>;
    const file = record['file'];
    if (typeof file !== 'string' || !isSafeOutputPath(file))
      throw new ViteConfigurationError(`Manifest chunk ${key} has unsafe file`);
    const chunk: ViteManifestChunk = Object.freeze({
      file,
      ...(typeof record['src'] === 'string' ? { src: record['src'] } : {}),
      ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
      ...(record['isEntry'] === true ? { isEntry: true } : {}),
      ...(record['isDynamicEntry'] === true ? { isDynamicEntry: true } : {}),
      imports: stringList(record['imports'], 'imports'),
      dynamicImports: stringList(record['dynamicImports'], 'dynamicImports'),
      css: outputList(record['css'], 'css'),
      assets: outputList(record['assets'], 'assets'),
    });
    manifest.set(key, chunk);
  }
  for (const [key, chunk] of manifest)
    for (const imported of [
      ...(chunk.imports ?? []),
      ...(chunk.dynamicImports ?? []),
    ])
      if (!manifest.has(imported))
        throw new ViteConfigurationError(
          `Manifest chunk ${key} imports unknown chunk ${imported}`,
        );
  return manifest;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ViteConfigurationError('Vite manifest is not valid JSON', {
      cause: error,
    });
  }
}

/** A manifest loaded from disk with a content hash usable as asset version. */
export interface LoadedViteManifest {
  readonly path: string;
  readonly manifest: ViteManifest;
  /** First 16 hex characters of the SHA-256 of the manifest bytes. */
  readonly hash: string;
}

/**
 * Synchronously reads and validates a manifest at startup. Fails with a clear
 * message when the build has not run, instead of rendering broken documents.
 */
export function readViteManifest(path: string): LoadedViteManifest {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new ViteConfigurationError(
      `Vite manifest not found at ${path}; run \`vite build\` with build.manifest enabled`,
      { cause: error },
    );
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES)
    throw new ViteConfigurationError(`Vite manifest at ${path} is too large`);
  return Object.freeze({
    path,
    manifest: parseViteManifest(bytes.toString('utf8')),
    hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  });
}

/** Validates a Vite `base`: `/…/` or an absolute `https:`/`http:` URL ending in `/`. */
export function normalizeBase(base: string): string {
  if (typeof base !== 'string' || !base.endsWith('/'))
    throw new ViteConfigurationError('Vite base must end with "/"');
  if (base.startsWith('/')) {
    if (base.startsWith('//') || /[\\\s?#]/.test(base))
      throw new ViteConfigurationError('Vite base must be a plain path');
    return base;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch (error) {
    throw new ViteConfigurationError('Vite base must be a path or URL', {
      cause: error,
    });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ViteConfigurationError('Vite base URL must be plain http(s)');
  return url.href;
}

/**
 * Collects the scripts, stylesheets and static-import preloads for entries
 * (manifest keys such as `client/app.tsx`). Dynamic imports are not preloaded
 * so code-split pages load on demand.
 */
export function resolveEntryAssets(
  manifest: ViteManifest,
  entries: readonly string[],
  base = '/',
): ViteEntryAssets {
  const prefix = normalizeBase(base);
  const scripts: string[] = [];
  const styles = new Set<string>();
  const preloads = new Set<string>();
  const seen = new Set<string>();
  const visit = (key: string, root: boolean): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest.get(key);
    if (!chunk)
      throw new ViteConfigurationError(`Vite manifest has no entry ${key}`);
    for (const imported of chunk.imports ?? []) visit(imported, false);
    for (const css of chunk.css ?? []) styles.add(prefix + css);
    if (chunk.file.endsWith('.css')) styles.add(prefix + chunk.file);
    else if (root) scripts.push(prefix + chunk.file);
    else preloads.add(prefix + chunk.file);
  };
  for (const entry of entries) {
    const chunk = manifest.get(entry);
    if (!chunk)
      throw new ViteConfigurationError(`Vite manifest has no entry ${entry}`);
    if (chunk.isEntry !== true && !chunk.file.endsWith('.css'))
      throw new ViteConfigurationError(`${entry} is not a Vite build entry`);
    visit(entry, true);
  }
  for (const script of scripts) preloads.delete(script);
  return Object.freeze({
    scripts: Object.freeze(scripts),
    styles: Object.freeze([...styles]),
    preloads: Object.freeze([...preloads]),
  });
}
