import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

// ADR 0035 (amending ADR 0020): the entry every Live page loads has its own
// hard gate; each on-demand feature chunk has one; and the worst case (a page
// using every feature) stays bounded. All gzip level 9, maps excluded.
const budgets = [
  { file: 'index.js', role: 'core', gzipBudget: 44 * 1024 },
  { file: 'live-sort.js', role: 'chunk', gzipBudget: 6 * 1024 },
  { file: 'live-stream.js', role: 'chunk', gzipBudget: 4.5 * 1024 },
  { file: 'live-upload.js', role: 'chunk', gzipBudget: 5 * 1024 },
  { file: 'live-realtime.js', role: 'chunk', gzipBudget: 3 * 1024 },
];
const totalBudget = 60 * 1024;

const files = [];
for (const budget of budgets) {
  let content;
  try {
    content = await readFile(join('packages/client/dist', budget.file));
  } catch {
    throw new Error(`Build the client before measuring size (${budget.file}).`);
  }
  const gzipBytes = gzipSync(content, { level: 9 }).byteLength;
  files.push({
    ...budget,
    bytes: content.byteLength,
    gzipBytes,
    passed: gzipBytes <= budget.gzipBudget,
  });
}
const source = await readFile('packages/client/dist/index.js', 'utf8');
// Every dynamic import of the entry must be a budgeted sibling chunk.
const imported = [...source.matchAll(/import\("\.\/([^"]+)"\)/g)].map(
  ([, name]) => name,
);
const unbudgeted = imported.filter(
  (name) => !budgets.some((budget) => budget.file === name),
);
const core = files.find((file) => file.role === 'core');
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  scope:
    'Canonical Live entry (loaded by every Live page) and each on-demand feature chunk it imports, all served by nestvexa/assets. Excludes Alpine, its adapter and sourcemaps. Private per-module test outputs are not published or served. Gzip estimate; example servers do not automatically enable HTTP compression.',
  files,
  core: core?.gzipBytes ?? 0,
  gzipBudget: core?.gzipBudget ?? 0,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
  totalBudget,
  unbudgeted,
  passed: false,
};
report.passed =
  files.every((file) => file.passed) &&
  report.gzipBytes <= totalBudget &&
  unbudgeted.length === 0 &&
  imported.length === budgets.length - 1;
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/client-size.json',
  JSON.stringify(report, null, 2),
);
for (const file of files)
  console.log(
    `${file.role === 'core' ? 'Live core ' : 'Live chunk'} ${file.file}: ${file.bytes} bytes; ${file.gzipBytes} gzip (budget ${file.gzipBudget})${file.passed ? '' : ' OVER BUDGET'}`,
  );
console.log(
  `All Live code: ${report.gzipBytes} gzip across ${files.length} files (budget ${totalBudget}).`,
);
if (unbudgeted.length)
  console.log(`Unbudgeted dynamic imports: ${unbudgeted.join(', ')}`);
if (!report.passed) process.exitCode = 1;
