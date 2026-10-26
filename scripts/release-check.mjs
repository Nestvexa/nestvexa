import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const failures = [];
const status = JSON.parse(
  await readFile('docs/implementation/progress.json', 'utf8'),
);
if (
  !Array.isArray(status.phases) ||
  status.phases.length !== 18 ||
  new Set(status.phases.map((phase) => phase.id)).size !== 18 ||
  status.phases.some(
    (phase) => !Number.isInteger(phase.id) || phase.id < 0 || phase.id > 17,
  )
)
  failures.push('Phase tracker must contain phases 0–17 exactly once.');
for (const phase of status.phases ?? [])
  if (phase.state !== 'Done')
    failures.push(`Phase ${phase.id}: ${phase.state}`);
const ledger = spawnSync(process.execPath, ['scripts/ledger.mjs', 'release'], {
  encoding: 'utf8',
  timeout: 30000,
});
if (ledger.status !== 0)
  failures.push(
    'Requirement ledger has missing evidence or incomplete requirements.',
  );
for (const [file, validate] of [
  [
    'artifacts/reports/vitest.json',
    (report) =>
      report.success === true &&
      report.numFailedTests === 0 &&
      report.numPendingTests === 0 &&
      report.numTotalTests > 0,
  ],
  [
    'artifacts/reports/playwright.json',
    (report) =>
      report.stats?.unexpected === 0 &&
      report.stats?.skipped === 0 &&
      report.stats?.expected > 0,
  ],
  [
    'artifacts/reports/pack.json',
    (report) =>
      report.passed === true &&
      report.consumers?.some(
        (consumer) => consumer.manager === 'npm' && consumer.passed,
      ) &&
      report.consumers?.some(
        (consumer) => consumer.manager === 'pnpm' && consumer.passed,
      ),
  ],
  [
    'artifacts/reports/release-matrix.json',
    (report) => report.passed === true && report.environments?.length > 0,
  ],
  [
    'artifacts/reports/security-review.json',
    (report) =>
      report.approved === true && report.openP0 === 0 && report.openP1 === 0,
  ],
]) {
  try {
    if (!validate(JSON.parse(await readFile(file, 'utf8'))))
      failures.push(`Failed or incomplete evidence: ${file}`);
  } catch {
    failures.push(`Missing readable evidence: ${file}`);
  }
}
const result = {
  timestamp: new Date().toISOString(),
  ready: failures.length === 0,
  failures,
  publicationAuthorized: false,
};
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/release-check.json',
  JSON.stringify(result, null, 2),
);
if (failures.length) {
  console.error('NOT YET READY — BLOCKERS');
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else
  console.log(
    'READY FOR OWNER RELEASE REVIEW; no publication performed or authorized.',
  );
