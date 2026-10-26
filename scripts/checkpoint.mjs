import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const manager = process.env.npm_execpath;
if (!manager) throw new Error('Run with pnpm checkpoint:check.');
await mkdir('artifacts/reports/commands', { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  scope:
    'Current implemented checkpoint; incomplete master release gates remain blocking',
  passed: false,
  releaseReady: false,
  commands: [],
};
const commands = [
  ['install', '--frozen-lockfile'],
  ['format:check'],
  ['lint'],
  ['typecheck'],
  ['test'],
  ['test:coverage'],
  ['size:check'],
  ['test:e2e'],
  ['test:pack'],
  ['docs:build'],
  ['ledger:check'],
  ['bench'],
  ['audit', '--audit-level', 'high'],
  ['release:check'],
];
for (const args of commands) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [manager, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output =
    `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`.replace(
      /npm_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9_.-]+/g,
      '[redacted credential]',
    );
  const file = `artifacts/reports/commands/${args[0].replaceAll(':', '-')}.log`;
  await writeFile(file, output);
  const entry = {
    command: `pnpm ${args.join(' ')}`,
    exitCode: result.status,
    milliseconds: Math.round(performance.now() - start),
    log: file,
  };
  report.commands.push(entry);
  console.log(
    `${entry.command}: exit ${String(entry.exitCode)} (${entry.milliseconds}ms)`,
  );
  if (result.status !== 0 && args[0] !== 'release:check') break;
}
report.passed =
  report.commands.length === commands.length &&
  report.commands
    .filter((entry) => entry.command !== 'pnpm release:check')
    .every((entry) => entry.exitCode === 0);
report.releaseReady = report.passed && report.commands.at(-1)?.exitCode === 0;
await writeFile(
  'artifacts/reports/verification.json',
  JSON.stringify(report, null, 2),
);
if (!report.passed) process.exitCode = 1;
console.log(
  `Checkpoint checks ${report.passed ? 'passed' : 'failed'}; release ready: ${report.releaseReady}.`,
);
