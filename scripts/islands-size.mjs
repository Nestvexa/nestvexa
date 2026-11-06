// Per-island size budgets: gzip bytes of each island's chunk graph (entry
// plus static imports) from the hybrid dashboard build, checked against the
// manifest `budgetBytes`, plus framework-separation evidence.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { analyzeIslandBundles } from '../packages/islands/dist/build.js';

const root = 'examples/hybrid-dashboard';
let manifest;
let metafile;
try {
  manifest = JSON.parse(
    await readFile(`${root}/dist/public/islands-manifest.json`, 'utf8'),
  );
  metafile = JSON.parse(
    await readFile(`${root}/dist/public/islands-metafile.json`, 'utf8'),
  );
} catch {
  throw new Error(
    'Build the hybrid dashboard example (pnpm --filter @nestvexa/example-hybrid-dashboard build) before measuring islands.',
  );
}
const analysis = analyzeIslandBundles(manifest, metafile, {
  outdir: 'dist/public/islands',
  publicPath: '/islands/',
  root,
});
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  scope:
    'Hybrid dashboard islands: gzip (level 9) bytes of each island entry chunk plus its static import closure, excluding the shared loader. Budgets come from the island manifest.',
  islands: analysis.islands.map((island) => ({
    id: island.id,
    framework: island.framework,
    gzipBytes: island.gzipBytes,
    budgetBytes: island.budgetBytes ?? null,
    passed: island.withinBudget,
    chunks: island.chunks.map((chunk) => ({
      file: chunk.file,
      gzipBytes: chunk.gzipBytes,
      frameworks: chunk.frameworks,
    })),
  })),
  frameworks: analysis.frameworks,
  violations: analysis.violations,
  passed: analysis.violations.length === 0,
};
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/islands-size.json',
  JSON.stringify(report, null, 2),
);
for (const island of report.islands)
  console.log(
    `${island.passed ? 'ok  ' : 'FAIL'} ${island.id} (${island.framework}): ${island.gzipBytes} gzip bytes${island.budgetBytes === null ? '' : ` / ${island.budgetBytes}`}`,
  );
for (const violation of report.violations) console.error(violation);
if (!report.passed) process.exitCode = 1;
