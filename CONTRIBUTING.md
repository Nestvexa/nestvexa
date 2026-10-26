# Contributing

Install Node 24 LTS and pnpm 10.26.1. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`. For browsers run `pnpm exec playwright install chromium` and `pnpm test:e2e`. `pnpm test:pack` validates local artifacts in an external consumer. `pnpm docs:build` checks links and creates readable source snapshots.

Use small Conventional Commits, strict TypeScript and a Changeset for public behavior changes. Add regression tests and accurate documentation. Do not disable a failed test or mark ledger rows Done without implementation, test, documentation, security and integration evidence. Follow the [master plan](NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md) and [status](docs/implementation/STATUS.md). Later phases remain required work, not community-delivery substitutes.

Legacy decorators are intentional for Nest integration. No unchecked `any`, blanket lint suppression or import from private package source paths in consumers. Keep backend and browser dependencies separate. Run `pnpm format` before review. Repository owner URLs and reviewer identities must be configured before accepting external contributions through hosted workflows.
