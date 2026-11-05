import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Evidence formats are documented in docs/release/evidence-formats.md. Every
// validator below only adds conditions; none may be relaxed for a release.
const failures = [];
const commit = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
async function sbomMatches(entry) {
  if (!entry?.sbom || typeof entry.sbom.file !== 'string') return false;
  try {
    const text = await readFile(entry.sbom.file, 'utf8');
    const sbom = JSON.parse(text);
    return (
      createHash('sha256').update(text).digest('hex') === entry.sbom.sha256 &&
      sbom.bomFormat === 'CycloneDX' &&
      sbom.specVersion === '1.6' &&
      sbom.metadata?.component?.hashes?.some(
        (hash) => hash.alg === 'SHA-256' && hash.content === entry.sha256,
      ) &&
      Array.isArray(sbom.components)
    );
  } catch {
    return false;
  }
}
const sbomResults = new Map();
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
      ) &&
      report.packages?.length > 0 &&
      // One coordinated version, and a verified SBOM for every tarball.
      new Set(report.packages.map((entry) => entry.version)).size === 1 &&
      report.packages.every(
        (entry) => sha256.test(entry.sha256) && sbomResults.get(entry.name),
      ),
  ],
  [
    'artifacts/reports/release-matrix.json',
    (report) =>
      report.passed === true &&
      report.environments?.length > 0 &&
      commit.test(report.commit ?? '') &&
      report.environments.every((environment) => environment.passed === true) &&
      ['linux', 'win32'].every((os) =>
        report.environments.some((environment) => environment.os === os),
      ) &&
      [22, 24].every((node) =>
        report.environments.some(
          (environment) => Number.parseInt(environment.node, 10) === node,
        ),
      ),
  ],
  [
    'artifacts/reports/security-review.json',
    (report) =>
      report.approved === true &&
      report.openP0 === 0 &&
      report.openP1 === 0 &&
      commit.test(report.reviewedCommit ?? '') &&
      // The internal review is not sufficient: 1.0 needs an independent reviewer.
      report.reviewers?.some((reviewer) => reviewer.independent === true) &&
      (report.findings ?? []).every(
        (finding) =>
          !['P0', 'P1'].includes(finding.severity) ||
          finding.status === 'fixed',
      ),
  ],
  [
    'artifacts/reports/load.json',
    (report) =>
      report.passed === true &&
      report.config?.latencyGate === 'enforce' &&
      report.realtimeHub?.passed === true &&
      report.memory?.length > 0 &&
      report.memory.every((entry) => entry.passed === true),
  ],
]) {
  try {
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    if (file.endsWith('pack.json'))
      for (const entry of evidence.packages ?? [])
        sbomResults.set(entry.name, await sbomMatches(entry));
    if (!validate(evidence))
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
