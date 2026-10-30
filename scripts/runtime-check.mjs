import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const major = Number(process.versions.node.split('.')[0]);
if (![22, 24].includes(major))
  throw new Error(
    'This compatibility fixture targets the declared Node 22/24 majors.',
  );
await mkdir('artifacts/reports', { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  passed: false,
  scope:
    'Strict test compilation and current aggregate unit/real HTTP/browser DOM suites; not Linux or a full release matrix',
  commands: [],
};
const commands = [
  [
    join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
    '-p',
    'tsconfig.tests.json',
    '--noEmit',
  ],
  [
    join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run',
    `--outputFile=artifacts/reports/node${major}-tests.json`,
  ],
];
for (const args of commands) {
  const start = performance.now();
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    // The aggregate includes real browser fixtures with bounded worker concurrency.
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const log = `artifacts/reports/node${major}-${report.commands.length}.log`;
  await writeFile(
    log,
    `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`,
  );
  report.commands.push({
    task: args[0].endsWith('tsc')
      ? 'strict compilation'
      : 'current aggregate suite',
    exitCode: result.status,
    milliseconds: Math.round(performance.now() - start),
    log,
  });
  console.log(
    `${process.version} ${report.commands.at(-1).task}: exit ${result.status}`,
  );
  if (result.status !== 0) break;
}
report.passed =
  report.commands.length === commands.length &&
  report.commands.every((command) => command.exitCode === 0);
await writeFile(
  `artifacts/reports/node${major}-compatibility.json`,
  JSON.stringify(report, null, 2),
);
if (!report.passed) process.exitCode = 1;
