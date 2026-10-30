import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sourceFingerprint } from './source-fingerprint.mjs';

const reportHashes = {};
async function read(path) {
  const content = await readFile(path);
  reportHashes[path] = createHash('sha256').update(content).digest('hex');
  return JSON.parse(content.toString('utf8'));
}
const verification = await read('artifacts/reports/verification.json');
const tests = await read('artifacts/reports/vitest.json');
const browser = await read('artifacts/reports/playwright.json');
const pack = await read('artifacts/reports/pack.json');
const size = await read('artifacts/reports/client-size.json');
const failures = [];
if (
  !verification.passed ||
  verification.sourceSha256 !== (await sourceFingerprint())
)
  failures.push(
    'Full checkpoint failed or source/tests/configuration changed afterward.',
  );
if (
  !tests.success ||
  tests.numFailedTests ||
  tests.numPendingTests ||
  tests.numTodoTests
)
  failures.push('Aggregate tests have failures or omissions.');
if (
  browser.errors.length ||
  browser.stats.unexpected ||
  browser.stats.skipped ||
  browser.stats.flaky
)
  failures.push('Browser checks have errors, omissions or flaky outcomes.');
const projects = browser.config.projects.map((project) => project.name).sort();
if (
  JSON.stringify(projects) !== JSON.stringify(['chromium', 'firefox', 'webkit'])
)
  failures.push('Required three browser engines missing.');
const expected = [
  'install --frozen-lockfile',
  'format:check',
  'lint',
  'typecheck',
  'test',
  'test:coverage',
  'size:check',
  'test:e2e',
  'test:pack',
  'docs:build',
  'ledger:check',
  'bench',
  'audit --audit-level high',
];
let cursor = Date.parse(verification.timestamp);
const windows = new Map();
for (const command of verification.commands) {
  windows.set(command.command, {
    start: cursor,
    end: cursor + command.milliseconds,
    exit: command.exitCode,
  });
  cursor += command.milliseconds;
}
for (const command of expected)
  if (windows.get('pnpm ' + command)?.exit !== 0)
    failures.push('Missing successful command: pnpm ' + command);
for (const [command, timestamp] of [
  ['test', tests.startTime],
  ['test:e2e', browser.stats.startTime],
  ['test:pack', pack.timestamp],
  ['size:check', size.timestamp],
]) {
  const time =
    typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  const window = windows.get('pnpm ' + command);
  if (
    !window ||
    !Number.isFinite(time) ||
    time < window.start - 5000 ||
    time > window.end + 5000
  )
    failures.push('Stale/mismatched report: ' + command);
}
if (
  !pack.passed ||
  pack.packages.length !== 7 ||
  pack.consumers.length !== 4 ||
  pack.consumers.some((consumer) => !consumer.passed)
)
  failures.push(
    'Seven packages and four full/minimal external consumers must pass.',
  );
for (const artifact of pack.packages)
  if (
    createHash('sha256')
      .update(await readFile(artifact.tarball))
      .digest('hex') !== artifact.sha256
  )
    failures.push('Changed tarball: ' + artifact.name);
if (!size.passed) failures.push('Custom browser runtime size budget failed.');

const evidence = {
  3.1: [
    'packages/client/src/index.ts',
    'packages/alpine/src/index.ts',
    'tests/alpine-start.test.ts',
    'tests/browser/default-setup.spec.ts',
  ],
  3.2: [
    'packages/client/src/morph.ts',
    'packages/client/src/control-state.ts',
    'packages/client/src/focus.ts',
    'tests/client-ownership-transitions.test.ts',
    'tests/browser/phase3-board.spec.ts',
    'tests/browser/editor-selection.spec.ts',
  ],
  3.3: [
    'packages/client/src/grammar.ts',
    'packages/client/src/bindings.ts',
    'packages/client/src/loading.ts',
    'packages/client/src/models.ts',
    'tests/client-bindings-dom.test.ts',
    'tests/browser/live.spec.ts',
    'tests/browser/models.spec.ts',
    'tests/browser/replacement-loading.spec.ts',
  ],
  3.4: [
    'packages/client/src/events.ts',
    'packages/client/src/listeners.ts',
    'tests/client-security.test.ts',
    'tests/client-events.test.ts',
    'tests/live-security.test.ts',
  ],
  3.5: [
    'packages/client/src/transport.ts',
    'packages/client/src/model-scheduler.ts',
    'tests/client-transport-lifecycle.test.ts',
    'tests/browser/request-lifecycle.spec.ts',
    'tests/browser/events.spec.ts',
  ],
  3.6: [
    'tests/browser/default-setup.spec.ts',
    'tests/browser/phase3-board.spec.ts',
    'tests/browser/form-reset.spec.ts',
    'tests/browser/multiple-select.spec.ts',
  ],
  3.7: [
    'scripts/size.mjs',
    'packages/client/src/index.ts',
    'tests/client-transport-lifecycle.test.ts',
    'tests/browser/assets.spec.ts',
    'docs/guides/client-diagnostics.md',
  ],
  exit: [
    'examples/starter-live/src/work-board.ts',
    'examples/starter-live/views/board.hbs',
    'tests/browser/phase3-board.spec.ts',
    'docs/implementation/phase3-acceptance.md',
    'docs/reference/directives.md',
  ],
};
for (const paths of Object.values(evidence))
  for (const path of paths)
    if (!(await readFile(path, 'utf8')).trim())
      failures.push('Empty evidence: ' + path);
const suites = [];
function collect(nodes) {
  for (const suite of nodes) {
    suites.push(suite);
    collect(suite.suites ?? []);
  }
}
collect(browser.suites);
const board = suites
  .filter(
    (suite) =>
      suite.file?.replaceAll('\\', '/').endsWith('/phase3-board.spec.ts') ||
      suite.file === 'phase3-board.spec.ts',
  )
  .flatMap((suite) => suite.specs ?? []);
if (
  board.flatMap((spec) => spec.tests).length < 18 ||
  board.some((spec) => !spec.ok)
)
  failures.push('All six real board scenarios must pass in all three engines.');
const report = {
  schemaVersion: 1,
  timestamp: new Date().toISOString(),
  phase: 3,
  passed: failures.length === 0,
  scope:
    'Tasks 3.1–3.7 and HBS reactive form/table exit gate on the executed environment; not acceptance of phases 0–2 or 4–17, Linux, the full release matrix or independent security review.',
  environment: { node: verification.node, platform: verification.platform },
  checkpointTimestamp: verification.timestamp,
  sourceSha256: verification.sourceSha256,
  aggregateTests: tests.numPassedTests,
  browserChecks: browser.stats.expected,
  evidence,
  reportSha256: reportHashes,
  failures,
};
await writeFile(
  'artifacts/reports/phase3-acceptance.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
