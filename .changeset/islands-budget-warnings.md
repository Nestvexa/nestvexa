---
'@nestvexa/islands': minor
---

Add `islandBudgetWarnings(report, { budgetBytes })` and the `budgetBytes` and
`onBudgetWarning` options of `islandsVitePlugin`, which warns after every build
(including watch rebuilds) about islands over their own or a configurable
default gzip budget. `pnpm size:check` now gates every island of the built
island examples against `scripts/island-budgets.mjs`.
