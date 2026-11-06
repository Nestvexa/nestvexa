import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Static analysis of the real Vite production builds of the React, Vue and
// Svelte examples (`pnpm build` produces them): source maps are emitted for
// client and SSR bundles, a single build never contains a module or package
// twice, and SSR bundles neither import nor bundle browser-only code and
// render in plain Node without DOM globals.

const repo = fileURLToPath(new URL('..', import.meta.url));

interface Adapter {
  readonly name: 'react' | 'vue' | 'svelte';
  readonly example: string;
  /** npm package that must be bundled exactly once into the client build. */
  readonly runtime: string;
  /** Packages of other frameworks that must never appear. */
  readonly foreign: RegExp;
  /** Bare specifiers an SSR bundle must never import. */
  readonly browserOnly: RegExp;
  /** Workspace client modules an SSR bundle must never inline. */
  readonly clientModule: string;
  readonly greeting: string;
}

const adapters: readonly Adapter[] = [
  {
    name: 'react',
    example: 'examples/inertia-react',
    runtime: 'react-dom',
    foreign: /^(?:vue|@vue\/|svelte|@inertiajs\/(?:vue3|svelte))/,
    browserOnly: /^(?:react-dom\/client|@vitejs\/|\/@vite\/|vite$)/,
    clientModule: 'packages/react/dist/client.js',
    greeting: 'Welcome to Nestvexa + React',
  },
  {
    name: 'vue',
    example: 'examples/inertia-vue',
    runtime: '@vue/runtime-core',
    foreign: /^(?:react|react-dom|svelte|@inertiajs\/(?:react|svelte))/,
    browserOnly: /^(?:@vue\/runtime-dom|@vitejs\/|\/@vite\/|vite$)/,
    clientModule: 'packages/vue/dist/client.js',
    greeting: 'Welcome to Nestvexa + Vue',
  },
  {
    name: 'svelte',
    example: 'examples/inertia-svelte',
    runtime: 'svelte',
    foreign: /^(?:react|react-dom|vue|@vue\/|@inertiajs\/(?:react|vue3))/,
    browserOnly: /^(?:svelte\/internal\/client|@sveltejs\/|\/@vite\/|vite$)/,
    clientModule: 'packages/svelte/dist/client.js',
    greeting: 'Welcome to Nestvexa + Svelte',
  },
];

function files(directory: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...files(path, suffix));
    else if (entry.endsWith(suffix)) found.push(path);
  }
  return found;
}

function build(adapter: Adapter, part: 'client' | 'ssr'): string {
  const directory = join(repo, adapter.example, 'dist', part);
  if (!existsSync(directory))
    throw new Error(
      `${adapter.example} is not built; run pnpm --filter ./${adapter.example} build`,
    );
  return directory;
}

interface SourceMap {
  readonly version: number;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
}

function sourceMap(file: string): SourceMap {
  return JSON.parse(readFileSync(`${file}.map`, 'utf8')) as SourceMap;
}

/** Repository-relative, forward-slash paths of every module in a chunk. */
function modules(file: string): string[] {
  return sourceMap(file).sources.map((source) =>
    relative(repo, resolve(dirname(file), source))
      .split(sep)
      .join('/'),
  );
}

const pnpmModule =
  /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/** `name@version` read from the package.json next to a pnpm store module. */
function packageOf(path: string): { name: string; version: string } | null {
  const match = pnpmModule.exec(path);
  if (!match?.[1]) return null;
  const root = path.slice(0, (match.index ?? 0) + match[0].length);
  const manifest = JSON.parse(
    readFileSync(join(repo, root, 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  return { name: manifest.name, version: manifest.version };
}

/** Static and dynamic import/export specifiers of an ES module. */
function specifiers(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    /(?:^|[;\s}])import\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+)["']/g,
    /(?:^|[;\s}])export\s*[\w*{}\s,$]*from\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ])
    for (const match of code.matchAll(pattern))
      if (match[1]) found.add(match[1]);
  return [...found];
}

describe.each(adapters)('$name example production build', (adapter) => {
  it('emits linked source maps with original sources for every client and SSR chunk', () => {
    for (const part of ['client', 'ssr'] as const) {
      const scripts = files(build(adapter, part), '.js');
      expect(scripts.length).toBeGreaterThan(1);
      for (const script of scripts) {
        const code = readFileSync(script, 'utf8');
        const name = script.slice(script.lastIndexOf(sep) + 1);
        expect(code.trimEnd(), name).toMatch(
          new RegExp(
            `//# sourceMappingURL=${name.replace(/[.$]/g, '\\$&')}\\.map$`,
          ),
        );
        const map = sourceMap(script);
        expect(map.version).toBe(3);
        expect(map.sources.length, name).toBeGreaterThan(0);
        expect(map.sourcesContent?.length).toBe(map.sources.length);
      }
    }
    // Page modules map back to their own source files.
    const pages = files(build(adapter, 'client'), '.js').flatMap(modules);
    expect(pages.some((path) => path.includes('/client/pages/Home.'))).toBe(
      true,
    );
  });

  it('bundles every module and package once, with one framework runtime and no foreign framework', () => {
    const owners = new Map<string, string[]>();
    const versions = new Map<string, Set<string>>();
    for (const chunk of files(build(adapter, 'client'), '.js')) {
      for (const path of new Set(modules(chunk))) {
        owners.set(path, [...(owners.get(path) ?? []), chunk]);
        const owner = packageOf(path);
        if (owner)
          versions.set(
            owner.name,
            (versions.get(owner.name) ?? new Set()).add(owner.version),
          );
      }
    }
    const duplicated = [...owners].filter(([, chunks]) => chunks.length > 1);
    expect(duplicated.map(([path]) => path)).toEqual([]);
    const multiVersion = [...versions].filter(([, set]) => set.size > 1);
    expect(multiVersion.map(([name]) => name)).toEqual([]);
    expect(versions.get(adapter.runtime)?.size).toBe(1);
    expect(versions.get('@inertiajs/core')?.size).toBe(1);
    expect(
      [...versions.keys()].filter((name) => adapter.foreign.test(name)),
    ).toEqual([]);
  });

  it('keeps browser-only code out of the SSR bundle', () => {
    const ssr = files(build(adapter, 'ssr'), '.js');
    const imported = new Set(
      ssr.flatMap((file) => specifiers(readFileSync(file, 'utf8'))),
    );
    expect(imported.size).toBeGreaterThan(0);
    expect(
      [...imported].filter((name) => adapter.browserOnly.test(name)),
    ).toEqual([]);
    const inlined = new Set(ssr.flatMap(modules));
    expect(
      [...inlined].filter((path) => path.endsWith(adapter.clientModule)),
    ).toEqual([]);
    expect(
      [...inlined].filter((path) =>
        /plugin-react\/preamble|vite\/dist\/client|\/@vite\/client/.test(path),
      ),
    ).toEqual([]);
    // The client bundle, by contrast, does contain the browser entry.
    const client = new Set(
      files(build(adapter, 'client'), '.js').flatMap(modules),
    );
    expect(
      [...client].some((path) => path.endsWith(adapter.clientModule)),
    ).toBe(true);
  });

  it('renders a page from the SSR bundle in plain Node without DOM globals', async () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
    const entry = join(build(adapter, 'ssr'), 'ssr.js');
    const module = (await import(pathToFileURL(entry).href)) as {
      render: (
        page: Record<string, unknown>,
      ) => Promise<{ head: readonly string[]; body: string }>;
    };
    const result = await module.render({
      component: 'Home',
      props: {
        errors: {},
        appName: 'Nestvexa Inertia',
        framework: adapter.name,
        greeting: adapter.greeting,
        visits: 1,
        renderedBy: 'build test',
      },
      url: '/',
      version: 'test',
      flash: {},
    });
    expect(result.body).toContain(adapter.greeting);
    expect(result.body).toContain('data-server-rendered="true"');
    // Importing and rendering defined no browser globals.
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
  });
});
