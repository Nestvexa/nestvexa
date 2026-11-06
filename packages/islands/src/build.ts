/**
 * Build-time helpers (Node only): turn bundler output into the island
 * manifest consumed by `IslandRegistry.fromManifest` and the browser loader,
 * and analyze per-island chunk graphs for framework separation and size
 * budgets. Works with any bundler that emits an esbuild-style metafile.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ------------------------------------------------------------------ Vite

/** One record of a Vite `build.manifest` file (`.vite/manifest.json`). */
export interface ViteManifestChunkLike {
  readonly file: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}
/** A parsed Vite manifest keyed by source path relative to the Vite root. */
export type ViteManifestLike = Readonly<Record<string, ViteManifestChunkLike>>;

export interface ViteIslandManifestOptions {
  /** The Vite `base` of the islands build, e.g. `/islands/`. */
  readonly base: string;
}

/**
 * Island manifest from a Vite build manifest: each definition's `entry` (a
 * Vite input relative to the Vite root, e.g. `client/islands/chart.tsx`) must
 * be an entry chunk, and its `file` under `base` becomes the bundle path. Add
 * {@link islandsMetafilePlugin} to the build when you also need the bundle
 * analysis.
 */
export function createViteIslandManifest(
  definitions: readonly IslandBuildDefinition[],
  viteManifest: ViteManifestLike,
  options: ViteIslandManifestOptions,
): IslandManifest {
  if (
    typeof options?.base !== 'string' ||
    !options.base.startsWith('/') ||
    options.base.startsWith('//')
  )
    throw new Error(
      'Vite island base must be a same-origin path such as /islands/',
    );
  const prefix = options.base.endsWith('/') ? options.base : `${options.base}/`;
  const islands: Record<string, IslandManifestEntry> = {};
  for (const definition of definitions) {
    const entry = slash(definition.entry);
    const chunk = Object.hasOwn(viteManifest, entry)
      ? viteManifest[entry]
      : undefined;
    if (!chunk || chunk.isEntry !== true || typeof chunk.file !== 'string')
      throw new Error(
        `No Vite entry chunk for island ${definition.id} (entry ${entry})`,
      );
    const bundle = `${prefix}${chunk.file}`;
    if (!ISLAND_BUNDLE_PATTERN.test(bundle))
      throw new Error(`Island bundle URL ${bundle} is not a safe module path`);
    islands[definition.id] = {
      framework: definition.framework,
      strategy: definition.strategy ?? 'visible',
      bundle,
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

/** The subset of a Rollup/Rolldown output item the Vite plugin reads. */
export interface IslandOutputLike {
  readonly type: 'chunk' | 'asset';
  readonly fileName: string;
  readonly code?: string;
  readonly facadeModuleId?: string | null;
  readonly isEntry?: boolean;
  readonly exports?: readonly string[];
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly moduleIds?: readonly string[];
}
/** The subset of Vite's resolved config the Vite plugin reads. */
export interface IslandViteConfigLike {
  readonly root: string;
  readonly base: string;
  readonly build: { readonly outDir: string; readonly ssr?: unknown };
}
export interface IslandsVitePluginOptions {
  /**
   * Island definitions. When given, the plugin writes the island manifest
   * and the bundle analysis next to the build after Vite wrote its files.
   */
  readonly islands?: readonly IslandBuildDefinition[];
  /** Public URL prefix of the build. Default: Vite's `base`. */
  readonly publicPath?: string;
  /** Metafile name inside `<outDir>/.vite`. Default `islands-metafile.json`. */
  readonly metafile?: string;
  /** Island manifest name inside `<outDir>/.vite`. Default `islands-manifest.json`. */
  readonly manifest?: string;
  /** Analysis report name inside `<outDir>/.vite`. Default `islands-analysis.json`. */
  readonly analysis?: string;
  /** Fail the build on a foreign framework runtime or a budget overrun. Default true. */
  readonly failOnViolation?: boolean;
  /** Receives the manifest and analysis once written (logging, extra copies). */
  readonly onReport?: (
    manifest: IslandManifest,
    report: IslandBundleReport,
  ) => void;
}
/** Config the plugin adds to client builds (Vite 8 / Rolldown option names). */
export interface IslandViteConfigPatch {
  readonly build: {
    readonly rolldownOptions: {
      readonly preserveEntrySignatures: 'exports-only';
    };
  };
}
/** A Vite plugin object (structurally typed: this package never imports Vite). */
export interface IslandsVitePlugin {
  readonly name: 'nestvexa:islands';
  readonly apply: 'build';
  readonly enforce: 'post';
  config(
    config: unknown,
    env: { readonly isSsrBuild?: boolean },
  ): IslandViteConfigPatch | undefined;
  configResolved(config: IslandViteConfigLike): void;
  generateBundle(
    options: unknown,
    bundle: Readonly<Record<string, IslandOutputLike>>,
  ): void;
  writeBundle(): void;
}

const jsonFileName = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$/;
function jsonName(value: string | undefined, fallback: string): string {
  const name = value ?? fallback;
  if (!jsonFileName.test(name))
    throw new Error(
      `Island build file ${name} must be a plain .json file name`,
    );
  return name;
}

/**
 * Vite plugin for island builds (`vite build` with the island entries as
 * inputs). It records an esbuild-style metafile of the client output (output
 * paths relative to the Vite root, `entryPoint` = entry source, `imports` =
 * static `import-statement` and lazy `dynamic-import` chunks, `inputs` =
 * bundled module ids used to detect framework runtimes), so
 * {@link createIslandManifest} and {@link analyzeIslandBundles} work on Vite
 * output unchanged. With `islands`, it also writes the island manifest and the
 * analysis after the bundle is on disk and fails the build on violations. SSR
 * builds (`vite build --ssr`) are left alone.
 */
export function islandsVitePlugin(
  options: IslandsVitePluginOptions = {},
): IslandsVitePlugin {
  const files = {
    metafile: jsonName(options.metafile, 'islands-metafile.json'),
    manifest: jsonName(options.manifest, 'islands-manifest.json'),
    analysis: jsonName(options.analysis, 'islands-analysis.json'),
  };
  let root = process.cwd();
  let outDir = 'dist';
  let base = '/';
  let ssr = false;
  let metafile: IslandMetafile | undefined;
  const withoutDefault = new Set<string>();
  const fromRoot = (id: string): string => {
    if (id.startsWith('\0')) return id.slice(1);
    const path = slash(relative(root, id.split('?')[0] ?? id));
    return path.startsWith('..') ? slash(id) : path;
  };
  return {
    name: 'nestvexa:islands',
    apply: 'build',
    enforce: 'post',
    // Vite app builds drop entry exports by default; an island entry must
    // keep its `default` mount export for the loader.
    config(_config, env) {
      return env.isSsrBuild
        ? undefined
        : {
            build: {
              rolldownOptions: { preserveEntrySignatures: 'exports-only' },
            },
          };
    },
    configResolved(config) {
      root = resolve(config.root);
      outDir = slash(relative(root, resolve(root, config.build.outDir)));
      base = options.publicPath ?? config.base;
      ssr = Boolean(config.build.ssr);
    },
    generateBundle(_options, bundle) {
      if (ssr) return;
      const outputs: Record<string, IslandMetafile['outputs'][string]> = {};
      const key = (file: string) => `${outDir}/${file}`;
      withoutDefault.clear();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        if (
          output.isEntry &&
          output.facadeModuleId &&
          !(output.exports ?? []).includes('default')
        )
          withoutDefault.add(fromRoot(output.facadeModuleId));
        outputs[key(output.fileName)] = {
          bytes: Buffer.byteLength(output.code ?? ''),
          ...(output.isEntry && output.facadeModuleId
            ? { entryPoint: fromRoot(output.facadeModuleId) }
            : {}),
          imports: [
            ...(output.imports ?? []).map((path) => ({
              path: key(path),
              kind: 'import-statement',
            })),
            ...(output.dynamicImports ?? []).map((path) => ({
              path: key(path),
              kind: 'dynamic-import',
            })),
          ],
          inputs: Object.fromEntries(
            (output.moduleIds ?? []).map((id) => [fromRoot(id), {}]),
          ),
        };
      }
      metafile = { outputs };
    },
    writeBundle() {
      if (ssr || !metafile) return;
      // Next to Vite's own manifest: static servers skip dot directories, so
      // module paths in the metafile are never published.
      const directory = resolve(root, outDir, '.vite');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, files.metafile),
        JSON.stringify(metafile, null, 2),
      );
      if (!options.islands) return;
      const stripped = options.islands
        .map((island) => slash(island.entry))
        .filter((entry) => withoutDefault.has(entry));
      if (stripped.length > 0)
        throw new Error(
          `Island entries lost their default mount export (${stripped.join(', ')}); keep build.rolldownOptions.preserveEntrySignatures at 'exports-only'`,
        );
      const buildOptions = { outdir: outDir, publicPath: base, root };
      const manifest = createIslandManifest(
        options.islands,
        metafile,
        buildOptions,
      );
      const report = analyzeIslandBundles(manifest, metafile, buildOptions);
      writeFileSync(
        join(directory, files.manifest),
        JSON.stringify(manifest, null, 2),
      );
      writeFileSync(
        join(directory, files.analysis),
        JSON.stringify(report, null, 2),
      );
      options.onReport?.(manifest, report);
      if (options.failOnViolation !== false && report.violations.length > 0)
        throw new Error(
          `Island bundle violations: ${report.violations.join('; ')}`,
        );
    },
  };
}
