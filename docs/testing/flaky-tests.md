# Flaky browser tests

Playwright retries a failed test twice on CI (`retries: process.env.CI ? 2 : 0` in
[playwright.config.ts](../../playwright.config.ts)), so a shared runner that stalls
for a moment does not turn a whole pull request red. A test that fails and then
passes on a retry gets the outcome **flaky**. Without a gate it would look exactly
like a pass, and a real race could hide behind the retries. This page is the policy
for those outcomes (ledger rows QA-081 and QA-052).

## Policy

| Where                                                                    | Command                                                     | Effect of a flaky test                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Pull requests and pushes ([ci.yml](../../.github/workflows/ci.yml))      | `node scripts/flaky-check.mjs --mode=report`                | Warning annotation on the spec line and a table in the job summary. The job stays green. |
| Nightly ([nightly.yml](../../.github/workflows/nightly.yml), per engine) | `node scripts/flaky-check.mjs --mode=block`                 | The nightly job fails, so the flake is visible every morning until someone fixes it.     |
| Release matrix ([release.yml](../../.github/workflows/release.yml))      | `node scripts/flaky-check.mjs --mode=block`                 | The matrix leg fails and no matrix entry is recorded for it.                             |
| Release candidate (`pnpm release:check`)                                 | built into [release-check](../../scripts/release-check.mjs) | `stats.flaky` must be 0 and every flaky test is named as a blocker.                      |
| Locally                                                                  | `pnpm flaky:check`                                          | Same as block mode, over your last `artifacts/reports/playwright.json`.                  |

Flakes are allowed on pull requests because a contributor should not be blocked by
a timing problem in code they did not touch. They are never allowed into a release:
a test that needed a retry is not evidence that the behaviour works. There is no
quarantine list. A flaky test is fixed (or the bug it found is fixed); it is not
skipped, and `retries` is not raised to hide it.

## What the check reads

The script reads the JSON reporter output (`artifacts/reports/playwright.json`, or
a path given as the first argument) and walks every suite. It reports each test
whose final status is `flaky` with its project (browser), file and line, title,
number of attempts and the first line of each failed attempt. It also reads
`stats.flaky` and uses the larger of the two counts, so a change in the report
shape cannot turn flakes into a pass. In block mode a missing or unreadable report
fails the check; in report mode it only prints a notice.

Each run writes `artifacts/reports/flaky.json`, which CI uploads with the rest of
the evidence. On GitHub Actions the same list goes to the job summary
(`GITHUB_STEP_SUMMARY`) and to `::warning` (report) or `::error` (block)
annotations.

## Fixing a flaky test

1. Download the `evidence-*` or `nightly-e2e-*` artifact and open the trace that
   Playwright kept for the failed attempt (`trace: 'retain-on-failure'`).
2. Reproduce locally with retries off: `pnpm exec playwright test <spec> --repeat-each=20 --project=<browser>`
   with a local config that starts only the server you need
   ([browser fixtures](browser-fixtures.md)).
3. Wait on visible state instead of fixed timeouts, and isolate state per test.
   If the flake is a product race, fix the product and add a regression test.

The tests for the check itself are in
[tests/quality-gates.test.ts](../../tests/quality-gates.test.ts).
