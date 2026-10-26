# Coverage gates

The initial high-risk gate measures the Live request parser/JSON copier, single-process state store and immutable core configuration. It is a partial coverage gate for exactly these production sources:

- `packages/live/src/protocol.ts`
- `packages/live/src/store.ts`
- `packages/core/src/config.ts`

Run from the repository root after installing dependencies:

```sh
pnpm exec vitest run --config vitest.coverage.config.ts --coverage
```

The V8 coverage provider must match Vitest exactly (`5.0.5`). Tests import these source modules directly, so the report measures their actual executed branches instead of counting compiled output twice. The configuration includes every branch in these three files, with no ignored lines or coverage suppression. Each file must meet90% branches and85% statements/functions/lines. A failing threshold fails the command and still writes reports.

The configuration follows the official [Vitest coverage reference](https://vitest.dev/config/coverage) and [V8 coverage guide](https://vitest.dev/guide/coverage.html). `coverage.include` is an explicit glob over the three files, so the reported scope remains inspectable.

Reports are generated under `artifacts/reports/coverage/high-risk`, including JSON summary, full JSON, HTML, LCOV and console output. The test report uses `artifacts/reports/high-risk-tests.json`, preserving the aggregate suite's usual report. Coverage is only an observation of code execution: it does not prove correct authorization, security, compatibility or absence of defects.

## Measured checkpoint

The command above passed locally on2026-10-26 with Node24.13.0, Vitest5.0.5 and `@vitest/coverage-v8`5.0.5 on Windows. It ran74 tests from the protocol/store and core suites. The V8 report contains exactly the three configured production files, with zero coverage exclusions or skipped counters.

| Scope              | Statements      | Branches        | Functions   | Lines           |
| ------------------ | --------------- | --------------- | ----------- | --------------- |
| Three-file total   | 219/223(98.20%) | 207/213(97.18%) | 35/35(100%) | 204/205(99.51%) |
| Core configuration | 34/35(97.14%)   | 35/37(94.59%)   | 7/7(100%)   | 29/30(96.66%)   |
| Live protocol      | 103/105(98.09%) | 100/103(97.08%) | 13/13(100%) | 97/97(100%)     |
| Live store         | 82/83(98.79%)   | 72/73(98.63%)   | 15/15(100%) | 78/78(100%)     |

The per-file thresholds passed. Existing behavior and negative tests already exceeded the gate, so no implementation-mirroring tests were added merely to increase a number. Future source changes must rerun the command and use the generated JSON summary as the authority; this table is a dated checkpoint.

This gate does not establish project-wide85% statement coverage, Live route/action pipeline coverage, browser runtime coverage, template adapter coverage or mutation-testing targets. Those remain separate release requirements. The complete test, security and browser suites must still run.
