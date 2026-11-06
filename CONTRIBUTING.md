# Contributing

Thanks for helping build Nestvexa. This page is the short version. The
[contributor handbook](docs/contributing/README.md) has the details.

## Set up

Install Node 22.13+ or 24 and pnpm 10.26.1, then:

```sh
pnpm install --frozen-lockfile
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

For browser tests run `pnpm exec playwright install chromium firefox webkit` and
`pnpm test:e2e`. `pnpm test:pack` validates the tarballs in external consumers.
`pnpm docs:build` checks the docs and builds the site. More detail:
[development setup](docs/contributing/development-setup.md),
[test matrix](docs/contributing/test-matrix.md) and [ports](docs/contributing/ports.md).

## Make a change

1. Open or find an issue. For a public API, protocol or security-model change, write
   or update an [ADR](docs/adr/README.md) first ([governance](GOVERNANCE.md#decision-process)).
2. Keep the pull request small. Use [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat(live): ...`, `fix(uploads): ...`, `docs: ...`).
3. Add tests:
   - every behaviour change needs one;
   - security-relevant behaviour needs negative tests;
   - add new test files to the right group script in `package.json`.
4. Update docs in the same pull request: the package README, the relevant guide, and
   the [feature matrix](docs/feature-matrix.md) when a feature's status changes.
5. Add a Changeset (`pnpm changeset`) for any change to published behaviour: `minor`
   for features, `patch` for fixes ([release process](docs/contributing/release-process.md)).
6. Run `pnpm format` (or `pnpm exec prettier --write <files>`), `pnpm lint` and the
   tests you touched before pushing.

## Standards

- **TypeScript.** Strict TypeScript. No `any`, no non-null assertions, no
  `eslint-disable`, no blanket suppressions.
- **Decorators.** Legacy decorators are intentional for Nest integration.
- **Imports.** Consumers never import private package paths. Keep backend and browser
  dependencies separate; `pnpm lint` runs the [boundary checks](scripts/boundaries.mjs).
- **Dependencies.** Optional integrations stay optional peers. A new dependency is
  pinned to an exact published version and justified in the pull request.
- **Honesty.** Never disable or skip a failing test. Never mark a
  [ledger](docs/implementation/feature-ledger.md) row Done, or document a feature as
  shipped, without implementation, test, documentation, security and integration
  evidence. Known gaps are written down, not hidden.
- **Scope.** The [master specification](NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md) and
  [status](docs/implementation/STATUS.md) define the required scope. Later phases
  remain required work, not community-delivery substitutes.

## Security

Never report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Conduct

Participation follows the [code of conduct](CODE_OF_CONDUCT.md).
