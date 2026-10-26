import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const files = [];
for (const file of (await readdir('packages/client/dist')).sort()) {
  if (!file.endsWith('.js')) continue;
  const content = await readFile(join('packages/client/dist', file));
  files.push({
    file,
    bytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
  });
}
if (!files.some((file) => file.file === 'index.js'))
  throw new Error('Build the client before measuring size.');
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  scope:
    'Emitted custom Live ES modules only, excluding Alpine and sourcemaps. Per-module gzip estimate; example server does not automatically enable HTTP compression.',
  files,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
  gzipBudget: 35 * 1024,
  passed: false,
};
report.passed = report.gzipBytes <= report.gzipBudget;
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/client-size.json',
  JSON.stringify(report, null, 2),
);
console.log(
  `Custom Live runtime: ${report.bytes} emitted bytes; ${report.gzipBytes} gzip bytes across ${files.length} modules (budget ${report.gzipBudget}).`,
);
if (!report.passed) process.exitCode = 1;
