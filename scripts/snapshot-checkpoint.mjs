import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [name, scope, calendarDate] = process.argv.slice(2);
if (!name || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || !scope)
  throw new Error(
    'Usage: node scripts/snapshot-checkpoint.mjs <name> "<scope>" [YYYY-MM-DD]',
  );
if (
  calendarDate &&
  (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate) ||
    !Number.isFinite(Date.parse(calendarDate)) ||
    new Date(calendarDate).toISOString().slice(0, 10) !== calendarDate)
)
  throw new Error(
    'Checkpoint calendar date must be a valid YYYY-MM-DD date; command timestamps remain UTC',
  );
const hashes = {};
async function read(path) {
  const text = await readFile(path, 'utf8');
  hashes[path] = createHash('sha256').update(text).digest('hex');
  return JSON.parse(text);
}
const directory = 'artifacts/reports';
const verification = await read(`${directory}/verification.json`);
if (!verification.passed)
  throw new Error('Cannot snapshot a failing checkpoint');
const tests = await read(`${directory}/vitest.json`);
const browser = await read(`${directory}/playwright.json`);
const pack = await read(`${directory}/pack.json`);
const size = await read(`${directory}/client-size.json`);
const benchmark = await read(`${directory}/benchmark.json`);
const coverage = await read(
  `${directory}/coverage/high-risk/coverage-summary.json`,
);
const ledger = await read('docs/implementation/feature-ledger.json');
const start = Date.parse(verification.timestamp);
if (!Number.isFinite(start)) throw new Error('Invalid checkpoint timestamp');
function commandWindow(command) {
  let cursor = start;
  for (const entry of verification.commands) {
    const end = cursor + entry.milliseconds;
    if (entry.command === command) return { start: cursor, end };
    cursor = end;
  }
  throw new Error(`Missing checkpoint command: ${command}`);
}
for (const [command, timestamp] of [
  ['pnpm test', tests.startTime],
  ['pnpm test:e2e', browser.stats.startTime],
  ['pnpm test:pack', pack.timestamp],
  ['pnpm size:check', size.timestamp],
  ['pnpm bench', benchmark.timestamp],
]) {
  const time =
    typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  const window = commandWindow(command);
  if (
    !Number.isFinite(time) ||
    time < window.start - 5000 ||
    time > window.end + 5000
  )
    throw new Error(
      `Report does not belong to ${command}; rerun the complete checkpoint`,
    );
}
const coverageWindow = commandWindow('pnpm test:coverage');
const coverageTime = (
  await stat(`${directory}/coverage/high-risk/coverage-summary.json`)
).mtimeMs;
if (
  coverageTime < coverageWindow.start - 5000 ||
  coverageTime > coverageWindow.end + 5000
)
  throw new Error('Coverage report does not belong to the checkpoint');
if (
  !tests.success ||
  tests.numFailedTests ||
  tests.numPendingTests ||
  tests.numTodoTests ||
  browser.errors.length ||
  browser.stats.unexpected ||
  browser.stats.skipped ||
  browser.stats.flaky ||
  !pack.passed ||
  !size.passed
)
  throw new Error('A report has failing, skipped or incomplete validation');
const runtimes = [];
for (const version of [22, 24]) {
  const path = `${directory}/node${version}-compatibility.json`;
  try {
    const report = await read(path);
    if (Date.parse(report.timestamp) < start) continue;
    const aggregate = await read(`${directory}/node${version}-tests.json`);
    if (
      !report.passed ||
      !aggregate.success ||
      aggregate.numTotalTests !== tests.numTotalTests
    )
      throw new Error(
        `Node ${version} report does not validate the current aggregate suite`,
      );
    runtimes.push({
      ...report,
      aggregate: {
        total: aggregate.numTotalTests,
        passed: aggregate.numPassedTests,
        failed: aggregate.numFailedTests,
        pending: aggregate.numPendingTests,
      },
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const states = {};
for (const feature of ledger.features)
  states[feature.state] = (states[feature.state] ?? 0) + 1;
const snapshot = {
  schemaVersion: 1,
  checkpointDate: calendarDate ?? verification.timestamp.slice(0, 10),
  scope,
  verificationTimestamp: verification.timestamp,
  environment: { node: verification.node, platform: verification.platform },
  implementedCheckpointPassed: verification.passed,
  releaseReady: verification.releaseReady,
  commands: verification.commands,
  tests: {
    total: tests.numTotalTests,
    passed: tests.numPassedTests,
    failed: tests.numFailedTests,
    pending: tests.numPendingTests,
  },
  browser: browser.stats,
  pack,
  clientSize: size,
  benchmark,
  highRiskCoverage: {
    total: coverage.total,
    files: Object.keys(coverage).filter((key) => key !== 'total'),
    scope:
      'Only selected configuration/protocol/store files; excludes runtime/action/client and most project code',
  },
  additionalRuntimes: runtimes,
  ledger: { total: ledger.features.length, states },
  reportSha256: hashes,
  limitations: [
    'No complete master phase accepted; release gates remain open',
    'Windows execution only; Linux and full release matrix remain unverified',
    'Controlled browser transport fixtures are not server conformance evidence',
    'No independent security certification, publication, remote push, SBOM or provenance attestation',
  ],
};
const destination = `docs/implementation/${name}-checkpoint-evidence-${snapshot.checkpointDate}.json`;
await writeFile(destination, JSON.stringify(snapshot, null, 2) + '\n');
console.log(
  `Saved ${destination}: ${tests.numPassedTests} tests, ${browser.stats.expected} browser checks; release ready: ${verification.releaseReady}`,
);
