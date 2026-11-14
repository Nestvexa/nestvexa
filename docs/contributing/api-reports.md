# Public API reports

Every published package has a committed report of its public TypeScript API under
[`api-reports/`](../../api-reports/). CI runs `pnpm api:check`, which fails when
the built typings no longer match the committed reports. A breaking change to an
export therefore cannot merge unnoticed: it shows up as a diff in the pull request,
next to the changeset that announces it (ledger rows QA-040, QA-049 and QA-090).

## What a report contains

[scripts/api-report.mjs](../../scripts/api-report.mjs) uses the TypeScript compiler
API (the workspace `typescript`, no extra dependency) over each package's built
`.d.ts` files:

- one section per `exports` subpath that has typings, in specifier order;
- every exported name, sorted, with its declaration exactly as the `.d.ts`
  declares it (signatures, members, type parameters), with comments removed so a
  documentation edit is not an API change;
- names re-exported from another workspace package as a one-line
  `export { X } from '@nestvexa/core'` (the owning package's report has the
  declaration), and the same for third-party re-exports;
- a "Referenced but not exported" section with package-local declarations that
  public signatures use without exporting, so changing a private options interface
  still changes the report.

The output does not depend on the operating system or the checkout path: names are
sorted, paths are package-relative and lines end with LF. Package versions are not
part of the report.

## Updating the reports

The check compares against the build output, so build first:

```sh
pnpm build
pnpm api:check    # fails and prints the changed lines when the API changed
pnpm api:update   # rewrites api-reports/*.api.md and removes reports of unpublished packages
```

Commit the updated reports in the same pull request as the code change, together
with a changeset (`pnpm changeset`) for each package whose report changed:

| Report change                                                                    | Changeset bump                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| New export, new optional option or overload                                      | `minor`                                                                    |
| Removed or renamed export, changed parameter or return type, new required option | `major` after 1.0; while packages are `0.x`, `minor` with a migration note |
| Only the "Referenced but not exported" section changed                           | Treat it like the export that references the declaration                   |

The changeset text should say what changed for consumers. Reviewers read the report
diff to confirm the bump: a report diff without a changeset, or a "patch" changeset
with a removed export, should not be approved. The release process is in
[release process](release-process.md).

## Known limits

- The report lists declarations, not semantics. A behaviour change behind an
  unchanged signature is caught by tests and protocol golden fixtures
  (`tests/fixtures/`), not by this check.
- Members inherited from third-party types (for example a NestJS base class) are
  not expanded; an upgrade of such a dependency is reviewed through its own
  changelog.
- `api:check` does not verify that a changeset exists; reviewers do. The tests for
  the generator are in [tests/quality-gates.test.ts](../../tests/quality-gates.test.ts).
