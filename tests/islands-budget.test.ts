import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  islandBudgetWarnings,
  islandsVitePlugin,
} from '../packages/islands/dist/build.js';
import type {
  IslandBudgetWarning,
  IslandBuildDefinition,
  IslandBundleAnalysis,
  IslandOutputLike,
} from '../packages/islands/dist/build.js';

// EXT-009: excessive island bundles. Development builds warn when an island
// is over its own or a configurable default budget, and `pnpm size:check`
// gates every built island of the example apps in CI.

interface BudgetResult {
  readonly islands: readonly {
    readonly id: string;
    readonly gzipBytes: number;
    readonly budgetBytes: number | null;
    readonly passed: boolean;
  }[];
  readonly failures: readonly string[];
  readonly passed: boolean;
}
const { checkIslandBudgets: check } = (await import(
  new URL('../scripts/island-budgets.mjs', import.meta.url).href
)) as {
  checkIslandBudgets(
    builds: readonly unknown[],
    cwd?: string,
  ): Promise<BudgetResult>;
};

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const analysis = (
  id: string,
  gzipBytes: number,
  budgetBytes?: number,
): IslandBundleAnalysis => ({
  id,
  framework: 'react',
  bundle: `/islands/${id}.js`,
  chunks: [],
  gzipBytes,
  budgetBytes,
  withinBudget: budgetBytes === undefined || gzipBytes <= budgetBytes,
});
/** Incompressible code of roughly `bytes` gzip bytes. */
const heavy = (bytes: number) =>
  `export default function mount(){return ${JSON.stringify(randomBytes(bytes).toString('base64'))}}`;

describe('islandBudgetWarnings', () => {
  it('warns for islands over their own or the default budget', () => {
    const warnings = islandBudgetWarnings(
      {
        islands: [
          analysis('own-over', 5_000, 4_000),
          analysis('own-ok', 3_000, 4_000),
          analysis('default-over', 9_000),
          analysis('default-ok', 7_000),
        ],
      },
      { budgetBytes: 8_000 },
    );
    expect(warnings).toEqual([
      {
        id: 'own-over',
        framework: 'react',
        gzipBytes: 5_000,
        budgetBytes: 4_000,
        source: 'island',
        message:
          'Island own-over (react) is 5000 gzip bytes, over its 4000 byte budget by 1000 bytes',
      },
      expect.objectContaining({
        id: 'default-over',
        budgetBytes: 8_000,
        source: 'default',
        message:
          'Island default-over (react) is 9000 gzip bytes, over its default 8000 byte budget by 1000 bytes',
      }),
    ]);
    // Without a default budget only islands with their own budget are checked.
    expect(
      islandBudgetWarnings({ islands: [analysis('free', 1_000_000)] }),
    ).toEqual([]);
    for (const budgetBytes of [0, -1, 1.5, Number.NaN])
      expect(() =>
        islandBudgetWarnings({ islands: [] }, { budgetBytes }),
      ).toThrow(/positive integer/);
  });
});

describe('islandsVitePlugin budget warnings', () => {
  const definitions: IslandBuildDefinition[] = [
    {
      id: 'chart',
      framework: 'react',
      entry: 'client/islands/chart.tsx',
      budgetBytes: 1_000,
    },
    { id: 'feed', framework: 'vue', entry: 'client/islands/feed.ts' },
  ];
  async function build(
    sizes: { readonly chart: number; readonly feed: number },
    options: Omit<Parameters<typeof islandsVitePlugin>[0] & object, 'islands'>,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'nv-island-budget-'));
    temporary.push(root);
    await mkdir(join(root, 'dist/islands/assets'), { recursive: true });
    const bundle: Record<string, IslandOutputLike> = {};
    for (const [name, size] of Object.entries(sizes)) {
      const fileName = `assets/${name}-H1.js`;
      const code = heavy(size);
      await writeFile(join(root, 'dist/islands', fileName), code);
      bundle[fileName] = {
        type: 'chunk',
        fileName,
        code,
        isEntry: true,
        facadeModuleId: join(
          root,
          name === 'chart'
            ? 'client/islands/chart.tsx'
            : 'client/islands/feed.ts',
        ),
        exports: ['default'],
        imports: [],
        dynamicImports: [],
        moduleIds: [],
      };
    }
    const plugin = islandsVitePlugin({ islands: definitions, ...options });
    plugin.configResolved({
      root,
      base: '/islands/',
      build: { outDir: 'dist/islands' },
    });
    plugin.generateBundle({}, bundle);
    plugin.writeBundle();
  }

  it('reports a default-budget overrun on every build without failing it', async () => {
    const warnings: IslandBudgetWarning[] = [];
    await build(
      { chart: 300, feed: 3_000 },
      { budgetBytes: 2_000, onBudgetWarning: (item) => warnings.push(item) },
    );
    expect(warnings.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: 'feed', source: 'default' },
    ]);
    // A rebuild (for example `vite build --watch` in development) warns again.
    await build(
      { chart: 300, feed: 3_000 },
      { budgetBytes: 2_000, onBudgetWarning: (item) => warnings.push(item) },
    );
    expect(warnings).toHaveLength(2);
    await build(
      { chart: 300, feed: 500 },
      { budgetBytes: 2_000, onBudgetWarning: (item) => warnings.push(item) },
    );
    expect(warnings).toHaveLength(2);
  });

  it('warns about an own-budget overrun before failing, or only warns when failures are off', async () => {
    const warnings: string[] = [];
    await expect(
      build(
        { chart: 3_000, feed: 300 },
        { onBudgetWarning: (item) => warnings.push(item.id) },
      ),
    ).rejects.toThrow(/chart is \d+ gzip bytes, over its 1000 byte budget/);
    expect(warnings).toEqual(['chart']);
    await expect(
      build(
        { chart: 3_000, feed: 300 },
        {
          failOnViolation: false,
          onBudgetWarning: (item) => warnings.push(item.id),
        },
      ),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual(['chart', 'chart']);
  });

  it('prints through console.warn by default and validates the budget', async () => {
    const printed: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => printed.push(String(message));
    try {
      await build({ chart: 300, feed: 3_000 }, { budgetBytes: 2_000 });
    } finally {
      console.warn = warn;
    }
    expect(printed).toEqual([
      expect.stringMatching(
        /^\[nestvexa:islands\] Island feed \(vue\) is \d+ gzip bytes, over its default 2000 byte budget/,
      ),
    ]);
    for (const budgetBytes of [0, 2.5])
      expect(() => islandsVitePlugin({ budgetBytes })).toThrow(
        /positive integer/,
      );
  });
});

describe('size:check island budgets', () => {
  async function example(sizes: Record<string, number>) {
    const cwd = await mkdtemp(join(tmpdir(), 'nv-island-size-'));
    temporary.push(cwd);
    const root = join(cwd, 'examples/demo');
    await mkdir(join(root, 'dist/islands'), { recursive: true });
    const islands: Record<string, unknown> = {};
    const outputs: Record<string, unknown> = {};
    for (const [id, size] of Object.entries(sizes)) {
      const file = `dist/islands/${id}-H1.js`;
      await writeFile(join(root, file), heavy(size));
      islands[id] = {
        framework: 'react',
        strategy: 'visible',
        bundle: `/islands/${id}-H1.js`,
        maxPropsBytes: 1024,
      };
      outputs[file] = { bytes: size, imports: [], inputs: {} };
    }
    await writeFile(
      join(root, 'dist/islands-manifest.json'),
      JSON.stringify({ version: 1, islands }),
    );
    await writeFile(
      join(root, 'dist/islands-metafile.json'),
      JSON.stringify({ outputs }),
    );
    return cwd;
  }
  const build = (budgets: Record<string, number>) => ({
    example: 'examples/demo',
    build: 'pnpm --filter demo build',
    manifest: 'dist/islands-manifest.json',
    metafile: 'dist/islands-metafile.json',
    outdir: 'dist/islands',
    publicPath: '/islands/',
    budgets,
  });

  it('passes islands within budget and fails overruns per island', async () => {
    const cwd = await example({ small: 200, large: 4_000 });
    const ok = await check([build({ small: 1_000, large: 10_000 })], cwd);
    expect(ok.passed).toBe(true);
    expect(ok.islands.map(({ id, passed }) => ({ id, passed }))).toEqual([
      { id: 'small', passed: true },
      { id: 'large', passed: true },
    ]);
    const over = await check([build({ small: 1_000, large: 2_000 })], cwd);
    expect(over.passed).toBe(false);
    expect(over.failures).toEqual([
      expect.stringMatching(
        /^examples\/demo: island large is \d+ gzip bytes, over its 2000 byte budget$/,
      ),
    ]);
  });

  it('fails unbudgeted, stale and unbuilt islands', async () => {
    const cwd = await example({ small: 200 });
    const result = await check(
      [build({ gone: 1_000 }), { ...build({}), example: 'examples/missing' }],
      cwd,
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      'examples/demo: island small has no size budget in scripts/island-budgets.mjs',
      'examples/demo: budgeted island gone is not in the built manifest',
      'examples/missing islands are not built; run pnpm --filter demo build (or pnpm build) first',
    ]);
  });
});
