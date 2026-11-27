// Per-island gzip budgets for the built island examples (EXT-009), checked by
// `pnpm size:check` in CI. Each island's size is its entry chunk plus its
// static import closure (gzip level 9, `analyzeIslandBundles`), excluding the
// shared loader. Every island in a manifest must have a budget here, and a
// manifest `budgetBytes` tighter than the table wins.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeIslandBundles } from '../packages/islands/dist/build.js';

export const islandBuilds = [
  {
    example: 'examples/hybrid-dashboard',
    build: 'pnpm --filter @nestvexa/example-hybrid-dashboard build',
    manifest: 'dist/public/islands-manifest.json',
    metafile: 'dist/public/islands-metafile.json',
    outdir: 'dist/public/islands',
    publicPath: '/islands/',
    budgets: {
      'revenue-chart': 80_000,
      'react-kpi': 80_000,
      'activity-feed': 45_000,
      'status-widget': 30_000,
      'broken-island': 2_000,
      'origin-react': 80_000,
      'origin-vue': 45_000,
      'origin-svelte': 30_000,
    },
  },
  {
    example: 'examples/islands-vite',
    build: 'pnpm --filter @nestvexa/example-islands-vite build',
    manifest: 'dist/islands/.vite/islands-manifest.json',
    metafile: 'dist/islands/.vite/islands-metafile.json',
    outdir: 'dist/islands',
    publicPath: '/islands/',
    budgets: {
      'counter-react': 80_000,
      'counter-vue': 45_000,
      'counter-svelte': 30_000,
    },
  },
];

/**
 * Measure every island of every build against its budget. A missing build,
 * an island without a budget, a budget for an island that no longer exists,
 * a foreign framework runtime or an overrun fails.
 */
export async function checkIslandBudgets(builds = islandBuilds, cwd = '.') {
  const results = [];
  const failures = [];
  for (const build of builds) {
    const root = join(cwd, build.example);
    let manifest;
    let metafile;
    try {
      manifest = JSON.parse(await readFile(join(root, build.manifest), 'utf8'));
      metafile = JSON.parse(await readFile(join(root, build.metafile), 'utf8'));
    } catch {
      failures.push(
        `${build.example} islands are not built; run ${build.build} (or pnpm build) first`,
      );
      continue;
    }
    const analysis = analyzeIslandBundles(manifest, metafile, {
      outdir: build.outdir,
      publicPath: build.publicPath,
      root,
    });
    for (const violation of analysis.violations)
      failures.push(`${build.example}: ${violation}`);
    const measured = new Set();
    for (const island of analysis.islands) {
      measured.add(island.id);
      const table = Object.hasOwn(build.budgets, island.id)
        ? build.budgets[island.id]
        : undefined;
      const budget =
        table === undefined
          ? undefined
          : Math.min(table, island.budgetBytes ?? table);
      const passed = budget !== undefined && island.gzipBytes <= budget;
      results.push({
        example: build.example,
        id: island.id,
        framework: island.framework,
        gzipBytes: island.gzipBytes,
        budgetBytes: budget ?? null,
        chunks: island.chunks.map((chunk) => chunk.file),
        passed,
      });
      if (budget === undefined)
        failures.push(
          `${build.example}: island ${island.id} has no size budget in scripts/island-budgets.mjs`,
        );
      else if (!passed)
        failures.push(
          `${build.example}: island ${island.id} is ${island.gzipBytes} gzip bytes, over its ${budget} byte budget`,
        );
    }
    for (const id of Object.keys(build.budgets))
      if (!measured.has(id))
        failures.push(
          `${build.example}: budgeted island ${id} is not in the built manifest`,
        );
  }
  return { islands: results, failures, passed: failures.length === 0 };
}
