/**
 * Build-time helpers (Node only): turn bundler output into the island
 * manifest consumed by `IslandRegistry.fromManifest` and the browser loader,
 * and analyze per-island chunk graphs for framework separation and size
 * budgets. Works with any bundler that emits an esbuild-style metafile.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { IslandDefinition } from './index.js';
import {
  DEFAULT_MAX_PROPS_BYTES,
  ISLAND_BUNDLE_PATTERN,
  parseIslandManifest,
} from './shared.js';
import type {
  IslandFramework,
  IslandManifest,
  IslandManifestEntry,
} from './shared.js';

export interface IslandBuildDefinition extends Omit<
  IslandDefinition,
  'bundle'
> {
  /** Entry source file, relative to the bundler working directory. */
  readonly entry: string;
}
/** The subset of an esbuild metafile the helpers read. */
export interface IslandMetafile {
  readonly outputs: Readonly<
    Record<
      string,
      {
        readonly bytes: number;
        readonly entryPoint?: string;
        readonly imports: readonly {
          readonly path: string;
          readonly kind: string;
        }[];
        readonly inputs: Readonly<Record<string, unknown>>;
      }
    >
  >;
}
export interface IslandBuildOptions {
  /** Output directory the bundler wrote to (relative to `root`). */
  readonly outdir: string;
  /** Public URL prefix of `outdir`, e.g. `/islands/`. */
  readonly publicPath: string;
  /** Bundler working directory; default `process.cwd()`. */
  readonly root?: string;
}

const slash = (path: string) => path.split(sep).join('/').replace(/\\/g, '/');

function publicUrl(
  output: string,
  options: IslandBuildOptions,
  root: string,
): string {
  const relativePath = slash(
    relative(resolve(root, options.outdir), resolve(root, output)),
  );
  if (relativePath.startsWith('..'))
    throw new Error(`Island output ${output} is outside ${options.outdir}`);
  const prefix = options.publicPath.endsWith('/')
    ? options.publicPath
    : `${options.publicPath}/`;
  const url = `${prefix}${relativePath}`;
  if (!ISLAND_BUNDLE_PATTERN.test(url))
    throw new Error(`Island bundle URL ${url} is not a safe module path`);
  return url;
}

/** Maps each definition's entry to its emitted chunk and returns the manifest. */
export function createIslandManifest(
  definitions: readonly IslandBuildDefinition[],
  metafile: IslandMetafile,
  options: IslandBuildOptions,
): IslandManifest {
  const root = options.root ?? process.cwd();
  const islands: Record<string, IslandManifestEntry> = {};
  for (const definition of definitions) {
    const entry = slash(definition.entry);
    const output = Object.entries(metafile.outputs).find(
      ([file, meta]) =>
        file.endsWith('.js') &&
        meta.entryPoint !== undefined &&
        slash(meta.entryPoint) === entry,
    );
    if (!output)
      throw new Error(
        `No bundle output for island ${definition.id} (entry ${entry})`,
      );
    islands[definition.id] = {
      framework: definition.framework,
      strategy: definition.strategy ?? 'visible',
      bundle: publicUrl(output[0], options, root),
      maxPropsBytes: definition.maxPropsBytes ?? DEFAULT_MAX_PROPS_BYTES,
      ...(definition.props ? { props: definition.props } : {}),
      ...(definition.signed ? { signed: true } : {}),
      ...(definition.budgetBytes
        ? { budgetBytes: definition.budgetBytes }
        : {}),
    };
  }
  return parseIslandManifest({ version: 1, islands });
}

export interface IslandChunk {
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  /** Frameworks whose runtime sources are bundled into this chunk. */
  readonly frameworks: readonly IslandFramework[];
}
export interface IslandBundleAnalysis {
  readonly id: string;
  readonly framework: IslandFramework;
  readonly bundle: string;
  /** Entry chunk plus its static import closure. */
  readonly chunks: readonly IslandChunk[];
  readonly gzipBytes: number;
  readonly budgetBytes: number | undefined;
  readonly withinBudget: boolean;
}
export interface IslandBundleReport {
  readonly islands: readonly IslandBundleAnalysis[];
  /** Chunk files grouped by the framework runtime they contain. */
  readonly frameworks: Readonly<Record<string, readonly string[]>>;
  /** Islands whose closure contains another framework's runtime, or over budget. */
  readonly violations: readonly string[];
}

const FRAMEWORK_INPUTS: readonly [IslandFramework, RegExp][] = [
  [
    'react',
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:react|react-dom|scheduler)\//,
  ],
  [
    'vue',
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:vue|@vue\/[a-z-]+)\//,
  ],
  ['svelte', /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?svelte\//],
];

/**
 * Bundle-analyzer evidence: per island, the chunks it loads (static import
 * closure of its entry), their gzip sizes, and which framework runtimes
 * they contain. A violation is a foreign framework runtime in an island's
 * closure or a closure over its `budgetBytes`.
 */
export function analyzeIslandBundles(
  manifest: IslandManifest,
  metafile: IslandMetafile,
  options: IslandBuildOptions,
): IslandBundleReport {
  const root = options.root ?? process.cwd();
  const byUrl = new Map<string, string>();
  for (const file of Object.keys(metafile.outputs))
    if (file.endsWith('.js'))
      try {
        byUrl.set(publicUrl(file, options, root), file);
      } catch {
        // Outputs outside the island directory (e.g. the loader) are ignored.
      }
  const chunkCache = new Map<string, IslandChunk>();
  const chunk = (file: string): IslandChunk => {
    const cached = chunkCache.get(file);
    if (cached) return cached;
    const meta = metafile.outputs[file];
    const content = readFileSync(join(root, file));
    const inputs = Object.keys(meta?.inputs ?? {}).map(slash);
    const result: IslandChunk = Object.freeze({
      file: slash(file),
      bytes: content.byteLength,
      gzipBytes: gzipSync(content, { level: 9 }).byteLength,
      frameworks: FRAMEWORK_INPUTS.filter(([, pattern]) =>
        inputs.some((input) => pattern.test(input)),
      ).map(([framework]) => framework),
    });
    chunkCache.set(file, result);
    return result;
  };
  const violations: string[] = [];
  const frameworks: Record<string, string[]> = {};
  const islands = Object.entries(manifest.islands).map(([id, entry]) => {
    const start = byUrl.get(entry.bundle);
    if (!start)
      throw new Error(`Island ${id} bundle ${entry.bundle} not found`);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.shift() ?? '';
      if (seen.has(file)) continue;
      seen.add(file);
      for (const imported of metafile.outputs[file]?.imports ?? [])
        if (imported.kind === 'import-statement') queue.push(imported.path);
    }
    const chunks = [...seen].sort().map(chunk);
    const gzipBytes = chunks.reduce((total, item) => total + item.gzipBytes, 0);
    for (const item of chunks)
      for (const framework of item.frameworks) {
        if (framework !== entry.framework)
          violations.push(
            `${id} (${entry.framework}) loads ${framework} runtime via ${item.file}`,
          );
        const list = (frameworks[framework] ??= []);
        if (!list.includes(item.file)) list.push(item.file);
      }
    const withinBudget =
      entry.budgetBytes === undefined || gzipBytes <= entry.budgetBytes;
    if (!withinBudget)
      violations.push(
        `${id} is ${gzipBytes} gzip bytes, over its ${entry.budgetBytes ?? 0} byte budget`,
      );
    return Object.freeze({
      id,
      framework: entry.framework,
      bundle: entry.bundle,
      chunks,
      gzipBytes,
      budgetBytes: entry.budgetBytes,
      withinBudget,
    });
  });
  for (const list of Object.values(frameworks)) list.sort();
  return Object.freeze({ islands, frameworks, violations });
}
