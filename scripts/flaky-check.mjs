import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Flaky-test gate over the Playwright JSON report (QA-081). Playwright retries
// failed tests on CI (playwright.config.ts); a test that fails and then passes
// on a retry has outcome "flaky" and is otherwise green. Policy, documented in
// docs/testing/flaky-tests.md:
// - `--mode=report` (pull requests and pushes): list every flaky test as a
//   warning annotation and in the job summary, exit 0.
// - `--mode=block` (nightly, release matrix, release candidate): any flaky
//   test fails the command.
// A missing or unreadable report always fails `block`, so absent evidence
// never counts as "no flakes".

/**
 * @typedef {{ file: string, line: number | null, title: string, project: string,
 *   attempts: number, errors: string[] }} FlakyTest
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {unknown[]} */
const list = (value) => (Array.isArray(value) ? value : []);

// ANSI colour sequences (ESC [ ... letter) that Playwright puts in messages.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/** First line of a Playwright error message without ANSI colour codes. */
function firstLine(error) {
  if (!isRecord(error) || typeof error.message !== 'string') return '';
  const text = error.message.replace(ansi, '');
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

/**
 * Every test whose final outcome is "flaky", in report order.
 * @param {unknown} report Parsed Playwright JSON reporter output.
 * @returns {FlakyTest[]}
 */
export function collectFlaky(report) {
  /** @type {FlakyTest[]} */
  const flaky = [];
  /** @param {unknown} suite @param {string[]} titles */
  const visit = (suite, titles) => {
    if (!isRecord(suite)) return;
    const path =
      typeof suite.title === 'string' &&
      suite.title !== '' &&
      suite.file !== suite.title
        ? [...titles, suite.title]
        : titles;
    for (const spec of list(suite.specs)) {
      if (!isRecord(spec)) continue;
      for (const test of list(spec.tests)) {
        if (!isRecord(test) || test.status !== 'flaky') continue;
        const results = list(test.results);
        flaky.push({
          file:
            typeof spec.file === 'string'
              ? spec.file
              : String(suite.file ?? ''),
          line: typeof spec.line === 'number' ? spec.line : null,
          title: [...path, String(spec.title ?? '')].join(' › '),
          project: typeof test.projectName === 'string' ? test.projectName : '',
          attempts: results.length,
          errors: results
            .filter((result) => isRecord(result) && result.status !== 'passed')
            .map((result) =>
              firstLine(isRecord(result) ? result.error : undefined),
            )
            .filter((line) => line !== ''),
        });
      }
    }
    for (const child of list(suite.suites)) visit(child, path);
  };
  if (isRecord(report))
    for (const suite of list(report.suites)) visit(suite, []);
  return flaky;
}

/**
 * Applies the policy to a parsed report.
 * @param {unknown} report
 * @param {'report' | 'block'} mode
 */
export function evaluate(report, mode) {
  const flaky = collectFlaky(report);
  const stats = isRecord(report) && isRecord(report.stats) ? report.stats : {};
  const statsFlaky = typeof stats.flaky === 'number' ? stats.flaky : 0;
  // Trust the larger count so a report shape change cannot hide flakes.
  const count = Math.max(flaky.length, statsFlaky);
  return { mode, count, flaky, failed: mode === 'block' && count > 0 };
}

/** @param {ReturnType<typeof evaluate>} result */
export function summaryMarkdown(result) {
  if (result.count === 0)
    return '### Flaky tests\n\nNo flaky Playwright tests.\n';
  const escape = (text) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = result.flaky.map(
    (test) =>
      `| ${escape(test.project)} | ${escape(`${test.file}${test.line === null ? '' : `:${test.line}`}`)} | ${escape(test.title)} | ${test.attempts} | ${escape(test.errors[0] ?? '')} |`,
  );
  const verdict =
    result.mode === 'block'
      ? 'Blocking: flaky tests fail nightly and release runs.'
      : 'Reported only: pull-request and push CI do not fail on flakes; nightly and release runs do.';
  return [
    `### Flaky tests: ${result.count}`,
    '',
    verdict,
    'Policy: docs/testing/flaky-tests.md',
    '',
    '| Project | Location | Test | Attempts | First failure |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg === '--mode=report' ? 'report' : 'block';
  if (modeArg && !['--mode=report', '--mode=block'].includes(modeArg)) {
    console.error(`Unknown ${modeArg}; use --mode=report or --mode=block.`);
    process.exitCode = 2;
    return;
  }
  const file =
    args.find((arg) => !arg.startsWith('--')) ??
    'artifacts/reports/playwright.json';
  let report;
  try {
    report = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    const message = `Missing or unreadable Playwright report: ${file}`;
    if (mode === 'block') {
      console.error(message);
      process.exitCode = 1;
    } else console.warn(`${message} (report mode, not failing).`);
    return;
  }
  const result = evaluate(report, mode);
  await mkdir('artifacts/reports', { recursive: true });
  await writeFile(
    'artifacts/reports/flaky.json',
    JSON.stringify(
      { timestamp: new Date().toISOString(), source: file, ...result },
      null,
      2,
    ),
  );
  const annotation = mode === 'block' ? 'error' : 'warning';
  for (const test of result.flaky) {
    const location = `${test.file}${test.line === null ? '' : `:${test.line}`}`;
    const text = `[${test.project}] ${location} ${test.title} passed after ${test.attempts} attempts`;
    if (process.env.GITHUB_ACTIONS === 'true')
      console.log(
        `::${annotation} file=tests/browser/${test.file},line=${test.line ?? 1},title=Flaky test::${text}`,
      );
    else console.log(`FLAKY ${text}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result));
  if (result.failed) {
    console.error(
      `${result.count} flaky Playwright test(s). Flakes block nightly and release runs; fix the cause (docs/testing/flaky-tests.md).`,
    );
    process.exitCode = 1;
  } else
    console.log(
      result.count === 0
        ? 'No flaky Playwright tests.'
        : `${result.count} flaky Playwright test(s) reported (not blocking in report mode).`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
