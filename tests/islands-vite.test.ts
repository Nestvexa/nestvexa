import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createViteIslandManifest,
  islandsVitePlugin,
} from '../packages/islands/dist/build.js';
import type {
  IslandBuildDefinition,
  IslandOutputLike,
} from '../packages/islands/dist/build.js';
import {
  IslandRegistry,
  moduleIslandRenderers,
} from '../packages/islands/dist/index.js';

const definitions: IslandBuildDefinition[] = [
  {
    id: 'chart',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/islands/chart.tsx',
    budgetBytes: 50_000,
    props: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: 20 } },
    },
  },
  { id: 'feed', framework: 'vue', entry: 'client/islands/feed.ts' },
];
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('createViteIslandManifest', () => {
  const viteManifest = {
    'client/islands/chart.tsx': {
      file: 'assets/chart-Ab12_x.js',
      src: 'client/islands/chart.tsx',
      isEntry: true,
      imports: ['_react-C1.js'],
    },
    'client/islands/feed.ts': {
      file: 'assets/feed-Zz9.js',
      isEntry: true,
    },
    '_react-C1.js': { file: 'assets/react-C1.js' },
  };

  it('maps island entries to bundle paths under the Vite base', () => {
    const manifest = createViteIslandManifest(definitions, viteManifest, {
      base: '/islands',
    });
    expect(manifest.islands['chart']).toEqual({
      framework: 'react',
      strategy: 'immediate',
      bundle: '/islands/assets/chart-Ab12_x.js',
      maxPropsBytes: 32_768,
      budgetBytes: 50_000,
      props: definitions[0]?.props,
    });
    expect(manifest.islands['feed']?.bundle).toBe(
      '/islands/assets/feed-Zz9.js',
    );
    expect(IslandRegistry.fromManifest(manifest).ids()).toEqual([
      'chart',
      'feed',
    ]);
  });

  it('rejects missing or non-entry chunks, unsafe bases and unsafe files', () => {
    expect(() =>
      createViteIslandManifest(
        [{ id: 'x', framework: 'react', entry: 'client/x.tsx' }],
        viteManifest,
        { base: '/islands/' },
      ),
    ).toThrow(/No Vite entry chunk/);
    expect(() =>
      createViteIslandManifest(
        [{ id: 'x', framework: 'react', entry: '_react-C1.js' }],
        viteManifest,
        { base: '/islands/' },
      ),
    ).toThrow(/No Vite entry chunk/);
    // Inherited keys never count as manifest entries.
    expect(() =>
      createViteIslandManifest(
        [{ id: 'x', framework: 'react', entry: 'constructor' }],
        viteManifest,
        { base: '/islands/' },
      ),
    ).toThrow(/No Vite entry chunk/);
    for (const base of ['//cdn.example/', 'https://cdn.example/', 'islands/'])
      expect(() =>
        createViteIslandManifest(definitions, viteManifest, { base }),
      ).toThrow(/same-origin path/);
    for (const file of ['../escape.js', 'assets/x.css', 'assets/a b.js'])
      expect(() =>
        createViteIslandManifest(
          [{ id: 'x', framework: 'vue', entry: 'client/x.ts' }],
          { 'client/x.ts': { file, isEntry: true } },
          { base: '/islands/' },
        ),
      ).toThrow(/not a safe module path/);
  });
});

describe('islandsVitePlugin', () => {
  async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'nv-islands-vite-'));
    temporary.push(root);
    await mkdir(join(root, 'dist/islands/assets'), { recursive: true });
    return root;
  }
  const chunk = (
    fileName: string,
    extra: Partial<IslandOutputLike> = {},
  ): IslandOutputLike => ({
    type: 'chunk',
    fileName,
    code: 'export default function mount() {}',
    exports: [],
    imports: [],
    dynamicImports: [],
    moduleIds: [],
    ...extra,
  });
  async function run(
    root: string,
    bundle: Record<string, IslandOutputLike>,
    options: Parameters<typeof islandsVitePlugin>[0] = {
      islands: definitions,
    },
  ) {
    for (const output of Object.values(bundle))
      if (output.type === 'chunk')
        await writeFile(
          join(root, 'dist/islands', output.fileName),
          output.code ?? '',
        );
    const plugin = islandsVitePlugin(options);
    plugin.configResolved({
      root,
      base: '/islands/',
      build: { outDir: 'dist/islands' },
    });
    plugin.generateBundle({}, bundle);
    plugin.writeBundle();
    const read = async (name: string): Promise<unknown> =>
      JSON.parse(
        await readFile(join(root, 'dist/islands/.vite', name), 'utf8'),
      );
    return { plugin, read };
  }
  const reactModule = (root: string) =>
    join(
      root,
      '../node_modules/.pnpm/react-dom@19/node_modules/react-dom/x.js',
    );
  const vueModule = (root: string) =>
    join(
      root,
      '../node_modules/.pnpm/vue@3/node_modules/@vue/runtime-dom/x.js',
    );

  it('keeps entry exports for client builds only', () => {
    const plugin = islandsVitePlugin();
    expect(plugin.config({}, {})).toEqual({
      build: { rolldownOptions: { preserveEntrySignatures: 'exports-only' } },
    });
    expect(plugin.config({}, { isSsrBuild: true })).toBeUndefined();
  });

  it('writes an esbuild-style metafile, the island manifest and the analysis into .vite', async () => {
    const root = await project();
    const { read } = await run(root, {
      'assets/chart-A1.js': chunk('assets/chart-A1.js', {
        isEntry: true,
        exports: ['default'],
        facadeModuleId: join(root, 'client/islands/chart.tsx'),
        imports: ['assets/react-R1.js'],
        dynamicImports: ['assets/lazy-L1.js'],
        moduleIds: [join(root, 'client/islands/chart.tsx')],
      }),
      'assets/feed-F1.js': chunk('assets/feed-F1.js', {
        isEntry: true,
        exports: ['default'],
        facadeModuleId: join(root, 'client/islands/feed.ts'),
        moduleIds: [vueModule(root)],
      }),
      'assets/react-R1.js': chunk('assets/react-R1.js', {
        moduleIds: [reactModule(root)],
      }),
      'assets/lazy-L1.js': chunk('assets/lazy-L1.js', {
        moduleIds: [vueModule(root)],
      }),
      'style.css': { type: 'asset', fileName: 'style.css' },
    });
    const metafile = (await read('islands-metafile.json')) as {
      outputs: Record<string, { entryPoint?: string; imports: unknown[] }>;
    };
    expect(metafile.outputs['dist/islands/assets/chart-A1.js']).toMatchObject({
      entryPoint: 'client/islands/chart.tsx',
      imports: [
        { path: 'dist/islands/assets/react-R1.js', kind: 'import-statement' },
        { path: 'dist/islands/assets/lazy-L1.js', kind: 'dynamic-import' },
      ],
    });
    expect(Object.keys(metafile.outputs)).not.toContain(
      'dist/islands/style.css',
    );
    expect(await read('islands-manifest.json')).toMatchObject({
      islands: {
        chart: { bundle: '/islands/assets/chart-A1.js', framework: 'react' },
        feed: { bundle: '/islands/assets/feed-F1.js', framework: 'vue' },
      },
    });
    // The lazily imported Vue chunk is not part of the React island's closure.
    const analysis = (await read('islands-analysis.json')) as {
      violations: string[];
      islands: {
        id: string;
        chunks: { file: string; frameworks: string[] }[];
      }[];
    };
    expect(analysis.violations).toEqual([]);
    expect(
      analysis.islands
        .find((island) => island.id === 'chart')
        ?.chunks.map((item) => [item.file, item.frameworks]),
    ).toEqual([
      ['dist/islands/assets/chart-A1.js', []],
      ['dist/islands/assets/react-R1.js', ['react']],
    ]);
    // Nothing is written next to the published assets.
    expect(existsSync(join(root, 'dist/islands/islands-manifest.json'))).toBe(
      false,
    );
  });

  it('fails the build on a foreign runtime or a lost default export', async () => {
    const root = await project();
    const entries = (chartExports: string[], chartImports: string[]) => ({
      'assets/chart-A1.js': chunk('assets/chart-A1.js', {
        isEntry: true,
        exports: chartExports,
        facadeModuleId: join(root, 'client/islands/chart.tsx'),
        imports: chartImports,
      }),
      'assets/feed-F1.js': chunk('assets/feed-F1.js', {
        isEntry: true,
        exports: ['default'],
        facadeModuleId: join(root, 'client/islands/feed.ts'),
      }),
      'assets/vue-V1.js': chunk('assets/vue-V1.js', {
        moduleIds: [vueModule(root)],
      }),
    });
    await expect(
      run(root, entries(['default'], ['assets/vue-V1.js'])),
    ).rejects.toThrow(/chart \(react\) loads vue runtime/);
    // The report is still written for inspection.
    expect(
      existsSync(join(root, 'dist/islands/.vite/islands-analysis.json')),
    ).toBe(true);
    await expect(run(root, entries([], []))).rejects.toThrow(
      /lost their default mount export \(client\/islands\/chart\.tsx\)/,
    );
    await expect(
      run(root, entries(['default'], ['assets/vue-V1.js']), {
        islands: definitions,
        failOnViolation: false,
      }),
    ).resolves.toBeDefined();
  });

  it('ignores SSR builds and validates file names', async () => {
    const root = await project();
    const plugin = islandsVitePlugin({ islands: definitions });
    plugin.configResolved({
      root,
      base: '/',
      build: { outDir: 'dist/islands', ssr: 'client/ssr.ts' },
    });
    plugin.generateBundle({}, { 'ssr.js': chunk('ssr.js', { isEntry: true }) });
    plugin.writeBundle();
    expect(existsSync(join(root, 'dist/islands/.vite'))).toBe(false);
    for (const name of ['../x.json', 'x.js', 'a/b.json'])
      expect(() => islandsVitePlugin({ manifest: name })).toThrow(
        /plain \.json file name/,
      );
  });
});

describe('moduleIslandRenderers', () => {
  const registry = (renderers: ReturnType<typeof moduleIslandRenderers>) =>
    new IslandRegistry([{ id: 'feed', framework: 'vue' }], {
      renderers,
      onRenderError: (error) => errors.push(String(error)),
    });
  let errors: string[] = [];
  afterEach(() => {
    errors = [];
  });

  it('loads the SSR module lazily, caches it, and retries a failed load', async () => {
    let loads = 0;
    const renderers = moduleIslandRenderers(['feed'], async () => {
      loads += 1;
      if (loads === 1) throw new Error('not built yet');
      return { renderers: { feed: () => '<p>ok</p>' } };
    });
    expect(loads).toBe(0);
    const islands = registry(renderers);
    expect((await islands.renderSsr('feed')).value).not.toContain(
      'data-nv-ssr',
    );
    expect(errors).toEqual(['Error: not built yet']);
    expect((await islands.renderSsr('feed')).value).toContain('<p>ok</p>');
    await islands.renderSsr('feed');
    expect(loads).toBe(2);
  });

  it('reloads on every render without cache (Vite ssrLoadModule)', async () => {
    let version = 0;
    const islands = registry(
      moduleIslandRenderers(
        ['feed'],
        async () => {
          version += 1;
          return { renderers: { feed: () => `<p>v${version}</p>` } };
        },
        { cache: false },
      ),
    );
    expect((await islands.renderSsr('feed')).value).toContain('<p>v1</p>');
    expect((await islands.renderSsr('feed')).value).toContain('<p>v2</p>');
  });

  it('falls back when the module lacks the renderer and rejects bad ids', async () => {
    for (const exported of [
      null,
      {},
      { renderers: {} },
      { renderers: { feed: 'not a function' } },
      { renderers: Object.create({ feed: () => 'inherited' }) },
    ]) {
      const islands = registry(
        moduleIslandRenderers(['feed'], async () => exported),
      );
      expect(
        (await islands.renderSsr('feed', {}, { fallback: 'F' })).value,
      ).toContain('>F</div>');
    }
    expect(
      errors.every((error) => /no renderer for island feed/.test(error)),
    ).toBe(true);
    expect(() => moduleIslandRenderers(['../x'], async () => ({}))).toThrow(
      /Invalid island id/,
    );
  });
});

// Evidence from the example build (`pnpm build` runs it).
describe('examples/islands-vite build', () => {
  const root = 'examples/islands-vite';
  const json = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(`${root}/${file}`, 'utf8'));

  it('keeps one framework runtime per island within budget', async () => {
    const analysis = (await json(
      'dist/islands/.vite/islands-analysis.json',
    )) as {
      violations: string[];
      islands: {
        id: string;
        framework: string;
        withinBudget: boolean;
        chunks: { frameworks: string[] }[];
      }[];
    };
    expect(analysis.violations).toEqual([]);
    expect(analysis.islands.map((island) => island.id).sort()).toEqual([
      'counter-react',
      'counter-svelte',
      'counter-vue',
    ]);
    for (const island of analysis.islands) {
      expect(island.withinBudget).toBe(true);
      expect([
        ...new Set(island.chunks.flatMap((item) => item.frameworks)),
      ]).toEqual([island.framework]);
    }
    // Every manifest bundle is an entry file of the Vite build manifest.
    const manifest = (await json(
      'dist/islands/.vite/islands-manifest.json',
    )) as {
      islands: Record<string, { bundle: string }>;
    };
    const vite = (await json('dist/islands/.vite/manifest.json')) as Record<
      string,
      { file: string; isEntry?: boolean }
    >;
    const entries = new Set(
      Object.values(vite)
        .filter((item) => item.isEntry)
        .map((item) => `/islands/${item.file}`),
    );
    for (const entry of Object.values(manifest.islands))
      expect(entries.has(entry.bundle)).toBe(true);
  });

  it(
    'server-renders every island from the Vite SSR bundle',
    { timeout: 60_000 },
    async () => {
      const manifest = await json('dist/islands/.vite/islands-manifest.json');
      const url = pathToFileURL(
        join(process.cwd(), root, 'dist/ssr/ssr.js'),
      ).href;
      const ids = ['counter-react', 'counter-vue', 'counter-svelte'];
      const islands = IslandRegistry.fromManifest(manifest, {
        renderers: moduleIslandRenderers(ids, () => import(url)),
      });
      for (const [id, text] of [
        ['counter-react', 'React clicks'],
        ['counter-vue', 'Vue clicks'],
        ['counter-svelte', 'Svelte clicks'],
      ] as const) {
        const html = (await islands.renderSsr(id, { label: text, start: 4 }))
          .value;
        expect(html).toContain('data-nv-ssr=""');
        expect(html).toMatch(
          new RegExp(`${text}(?:<!-- -->)?: (?:<!-- -->)?4`),
        );
      }
      await expect(
        islands.renderSsr('counter-vue', { label: 'x', start: 4, extra: 1 }),
      ).rejects.toThrow(/not a declared prop/);
    },
  );
});
