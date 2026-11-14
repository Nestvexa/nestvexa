---
'@nestvexa/observability': minor
---

Add `queryBudget()`, a development-only N+1 query detector: ORMs report each
executed statement through the structural `record()` hook (TypeORM
`Logger#logQuery`, Prisma `$on('query')`, Drizzle `logger`), statements are
counted per request (`middleware()`) or per `run()` scope by normalized shape,
and `n-plus-one` / `query-count` warnings name the repeated shape without
literal values. In production it returns a disabled hook. `normalizeQuery` and
`describeQueryBudgetWarning` are exported.
