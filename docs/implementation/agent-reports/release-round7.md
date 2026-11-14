# Release engineering and process rows: round 7

This round used branch `r7-rel7` in the worktree
`C:/Users/eslam/Desktop/nv-wt/rel7`, created from main `bd921f3`. It closes
six gaps from the round 6 process-row audit
(`.claude/coordination/ledger-audit-process.json` and
[release-round6.md](release-round6.md)). None of them needs the owner.

Nothing was published, tagged or pushed. The ledger, STATUS, progress and
FINAL_RELEASE_REPORT files were not edited.

## Summary by row

| Row        | What was added                                                                                              | Test evidence                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| REL-004    | `npx nestvexa init --install` from the packed bin in a fresh Nest app, then build, `doctor`, boot           | `pnpm test:pack` profile `npm:init`                                  |
| MAINT-007  | Out-of-tree view-engine adapter and extension, packed, installed from their own tarballs, booted            | `pnpm test:pack` profile `npm:third-party`                           |
| MAINT-017  | `emitDeprecation` in `@nestvexa/core`, codes `NVDEP001`/`NVDEP002`, used by `definePlugin`/`PluginRegistry` | `tests/core-deprecation.test.ts`                                     |
| MAINT-010  | `pr-policy` CI job: Conventional Commit title, and a changeset per changed published package                | `tests/pr-policy.test.ts`                                            |
| REVIEW-018 | Umbrella production closure held to an allowlist and deny-list, with an install-size budget                 | `tests/umbrella-dependencies.test.ts`                                |
| LEDGER-025 | `ledger.mjs check` rejects unfinished-work markers in cited Done evidence; CI runs check and self-test      | `tests/ledger-script.test.ts`, `node scripts/ledger.mjs --self-test` |

## REL-004: `npx nestvexa init` from the packed tarballs

Implementation: `scripts/pack-consumers.mjs` (`initConsumer`), wired into
`scripts/pack.mjs` as the `npm:init` consumer profile. Fixture:
`tests/pack-consumers/init-app/` (the `src/main.ts`, `src/app.module.ts`,
`src/app.controller.ts` and `tsconfig.json` of a fresh strict-ESM Nest app).

What the profile does, in a new `mkdtemp` directory under the OS temp
directory (outside the workspace):

1. Writes the fresh app's `package.json`: the Nest peers from the registry,
   `nestvexa` and (dev) `@nestvexa/cli` as `file:` tarballs, and npm
   `overrides` that pin every other `@nestvexa/*` package to its tarball
   (`$nestvexa`/`$@nestvexa/cli` for the direct ones). No Nestvexa package can
   come from the registry.
2. `npm install --ignore-scripts`.
3. `npx --no nestvexa init --install`. `--no` forbids npx from downloading;
   the command runs the packed umbrella bin, which delegates to the packed
   `@nestvexa/cli`. `--install` makes the CLI run `npm install` for the
   session packages it adds. The profile checks the output, that
   `nestvexa` still points at the tarball, that `express-session` and
   `@types/express-session` were added, and that `app.module.ts` was
   patched while `AppController` was kept.
4. `npm run build` (the app's own `tsc`), then `npx --no nestvexa doctor
--json`, which must report `pass` for nest, nestvexa, configure, session
   and layout.
5. Boots `dist/src/main.js` on `NESTVEXA_PACK_PORT` (or a free port) and
   checks: `/` still returns `Hello World!`; `/nestvexa` returns the layout
   with the welcome view and the Live counter; the Alpine boot script is
   served and starts `startLiveAlpine`; a Live `increment` with a forged
   CSRF token gets 403; with the session cookie and real token it gets 201
   and `count: 1`.

`scripts/release-check.mjs` now also requires a passed `init` and a passed
`third-party` consumer in `pack.json`; `tests/release-gate.test.ts` has the
updated passing fixture and two new refusal cases.

Docs: `docs/getting-started/README.md` (new "Installing from the packed
tarballs" section with the `overrides` recipe and `npx --no`),
`docs/contributing/development-setup.md` (consumer list,
`NESTVEXA_PACK_PROFILES`, `NESTVEXA_PACK_PORT`).

Remaining gap:

- The fixture is a strict ESM Nest app. The default `nest new` output is
  CommonJS, and that variant is not run from the packed bin.
- `npm install nestvexa` from the registry still needs the owner: the
  name and scope are not published (namespace caveat, unchanged).

## MAINT-007: third-party adapter from tarballs

Fixture `tests/pack-consumers/third-party/`:

- `engine/`: `nestvexa-engine-mini`, a `ViewEngineAdapter` for a
  `{{ name }}` language. It has a peer dependency on `@nestvexa/views` and
  imports only its public exports (`TemplateRoot`, `copyViewModel`,
  `expressViewModel`, `SafeHtml`, `ViewError`). Values are escaped; only
  server `SafeHtml` is raw. It supports layouts and has an Express
  `renderFile` bridge.
- `extension/`: `nestvexa-extension-mini`, a `defineExtension` package with a
  peer dependency on `@nestvexa/core`. It declares a capability, emits a
  diagnostics event in `register`, contributes a request-context field and
  has a `shutdown` hook.
- `consumer.ts`: the application.

Implementation: `scripts/pack-consumers.mjs` (`thirdPartyConsumer`), the
`npm:third-party` profile:

1. In a temporary "author" directory, the two packages are installed
   against the packed `@nestvexa/core` and `@nestvexa/views` tarballs,
   compiled with strict `tsc` (declarations emitted), and packed with
   `npm pack`. The profile checks that each tarball has `dist/index.js` and
   `dist/index.d.ts` and no `src/`.
2. A second temporary consumer installs `@nestvexa/core`, `views` and `live`
   from the Nestvexa tarballs, plus the two third-party tarballs. It
   type-checks `consumer.ts` with `skipLibCheck: false`, so the third-party
   declarations are checked too, and runs it.
3. The consumer checks the following:
   - the `ViewEngineRegistry` capability gate passes, and a missing
     capability is rejected;
   - the `@Render` MVC page renders through the adapter: layout, escaped
     title, the request-context field from the extension, and a Live
     counter;
   - a Live action with a forged CSRF token gets 403, and the real action
     returns its fragment `<output>1</output>`, rendered through the
     adapter without the layout;
   - the adapter rejects traversal (`INVALID_VIEW`), `__proto__` models
     (`UNSAFE_MODEL`) and themes (`UNSUPPORTED_CAPABILITY`);
   - the extension appears in `NestvexaExtensionHost.describe()`, its
     capability and diagnostics event are registered, and its `shutdown`
     ran once on `app.close()`.

Docs: `docs/guides/template-engines.md` (new "Publishing an adapter as its
own package" section), `docs/architecture/overview.md` (known gap
narrowed), `packages/core/README.md` (known gaps).

Remaining gap: the fixture lives in this repository and is copied to
temporary directories at test time. It is not a separately published
package or a separate repository. The extension contracts are still alpha,
without a stability promise.

## MAINT-017: runtime deprecation warnings

New file: `packages/core/src/deprecation.ts`, exported from
`@nestvexa/core`.

- `emitDeprecation(code, message)` calls `process.emitWarning(message, {
type: 'DeprecationWarning', code })` the first time a code is used in a
  process and returns `true`. Later calls, and calls under
  `--no-deprecation`, return `false`.
- Because it is a standard Node deprecation warning,
  `--trace-deprecation` and `--throw-deprecation` also apply.
- Codes must have an uppercase prefix, `DEP` and three digits. `NVDEP` is
  reserved for the framework; extensions use their own prefix, for example
  `ACMEDEP001`. A malformed code or an empty message is rejected.
- `NESTVEXA_DEPRECATIONS` (frozen) holds the framework's codes:
  - `NVDEP001`: `definePlugin()`;
  - `NVDEP002`: `new PluginRegistry()`.
- `pluginExtension` and `registry.install` validate through an internal
  function and do not warn: they are the migration path.

Tests (`tests/core-deprecation.test.ts`) run fresh Node processes, so
results do not depend on test order. They cover:

- exactly one warning per code, even after repeated calls;
- no warning on the migration path;
- `--no-deprecation`, `--throw-deprecation` and `--trace-deprecation`;
- in process: the `warning` event carries the code and fires once;
- negative cases: malformed codes and empty messages;
- the policy doc's code table equals `NESTVEXA_DEPRECATIONS`.

Docs:

- `docs/release/versioning-and-deprecation.md`: policy step 2 now names the
  helper, and a new "Runtime deprecation warnings" section has the codes
  table.
- `GOVERNANCE.md`: the known gap for the helper is removed; the codemod gap
  stays.
- `packages/core/README.md`.

Changeset: `.changeset/core-deprecation-warnings.md` (core, minor).

## MAINT-010: PR title and changeset enforcement

`scripts/pr-check.mjs` reads `PR_TITLE`, `PR_LABELS` (a JSON array) and
`PR_BASE_SHA` from the environment. It enforces two rules:

- **Title.** The title must be a Conventional Commit header (`type(scope)!:
subject`) with the types in CONTRIBUTING, a lowercase scope, no final
  period and at most 100 characters. GitHub's `Revert "..."` titles are
  accepted when the inner title is valid.
- **Changesets.** Every published package with a change under
  `packages/<dir>/src/` must be named by a non-`none` release in a
  changeset that the PR adds or edits (changesets in the diff from the
  merge base). The `no-changeset` label skips this rule. Invalid changesets
  and changesets naming unpublished packages are errors.

Git revisions are validated before they reach `git diff`. PR text never
reaches a shell.

The `.github/workflows/ci.yml` job `pr-policy` runs only when
`github.event_name == 'pull_request'`. It uses `fetch-depth: 0` and
`persist-credentials: false`, and needs no install. PR text is passed
through `env`.

Tests (`tests/pr-policy.test.ts`, 32 cases):

- valid and invalid titles;
- coverage per package, label opt-out, `none` bumps, invalid and unknown
  changesets, Windows separators;
- a real temporary git repository with base/topic commits: fails without
  a changeset, passes with the label, passes after a changeset is added,
  fails on a bad title, rejects bad revisions and a missing base;
- the `ci.yml` job shape, including that no `run:` line interpolates
  `github.event.pull_request`.

Docs: `CONTRIBUTING.md` (title format, the `pr-policy` job and the
`no-changeset` label).

Remaining gaps:

- Editing the title or labels does not trigger a new `pull_request` run
  with the default event types; the job must be re-run. The comment in
  `ci.yml` and `CONTRIBUTING.md` say so.
- Individual commit messages are not linted, only the PR title. Squash
  merges use the title.
- Required checks and branch protection are GitHub settings (owner).

## REVIEW-018: umbrella dependency budget

`tests/umbrella-dependencies.test.ts` resolves the `nestvexa` production
closure from `pnpm-lock.yaml` with `scripts/sbom.mjs` (`buildSbom`), the
same resolver as the release SBOMs. It asserts:

- the third-party runtime packages are exactly the allowlist at locked
  versions: `@alpinejs/csp`, `@vue/reactivity`, `@vue/shared`,
  `handlebars`, `minimist`, `neo-async`, `source-map`, `uglify-js`,
  `wordwrap`;
- the Nestvexa dependencies are exactly `alpine`, `client`, `core`,
  `engine-hbs`, `live` and `views`, and the peers are exactly `@nestjs/common`,
  `@nestjs/core`, `@nestvexa/cli` (optional), `reflect-metadata` and `rxjs`;
- a deny-list (React, Vue, Svelte, Angular, Inertia, Vite, bundlers, AWS,
  GCS and Azure storage, MinIO, Redis clients, ORMs and database drivers)
  matches nothing in the closure. The test also checks that the deny-list
  catches representative names and spares the allowlist;
- installed bytes stay within budget: third-party package directories at
  most 8 MiB (measured about 6.6 MB), and the total with the Nestvexa
  packages' packed files at most 12 MiB (measured about 9.4 MB).

Docs: `docs/architecture/package-dependency-graph.md`. The test is in
`test:unit` and `test:security`.

Remaining gap: the size is measured from the workspace install
(`node_modules/.pnpm`), not from an npm install of the tarball. The pack
`minimal` consumer installs the umbrella only, but its size is not
recorded.

## LEDGER-025: marker detection in `ledger.mjs`

`validateLedger` now reports `<id> cites evidence with unfinished-work
markers: <path> (line N: ...)` for Done rows. It reports at most three
lines per file. It checks implementation and test files for:

- the upper-case words TODO, FIXME, XXX and STUB;
- "not yet implemented".

Lower-case `stub`, which is legitimate in the Live runtime's `data-nv-stub`
markup and in test doubles, is not reported. The regex uses character
classes, and the self-test fixtures are assembled at run time, so
`ledger.mjs` contains none of the markers or stubs it rejects. The
self-test asserts this, so the script can be cited as Done evidence
itself. `findWorkMarkers` is exported.

Tests:

- `--self-test` covers every marker, lower-case names, Pending rows not
  being read, and the self-check;
- `tests/ledger-script.test.ts` (15 cases) covers each marker in
  implementation and test files, the three-line cap, false positives, Done
  rows only, the existing stub and skip rules, `check` on the committed
  ledger, `--self-test`, an unknown command, and the `ci.yml` job.

CI: a new `ledger` job in `ci.yml` runs `node scripts/ledger.mjs
--self-test` and `node scripts/ledger.mjs check` on every event, with no
install.

`node scripts/ledger.mjs check` still passes on the committed ledger
(925 requirements, 96 Done): no current Done evidence has a marker.

Remaining gaps from the audit, not in this assignment:

- "unimplemented commands" are not checked against the CLI command list;
- the ledger is still not updated after each phase (coordinator).

## Commands run

All commands ran on Windows with Node 24.13.0, one test file at a time.

| Command                                                                                               | Result                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm build`                                                        | exit 0                                                                                         |
| `pnpm --filter @nestvexa/core build`                                                                  | exit 0                                                                                         |
| `pnpm exec vitest run tests/core-deprecation.test.ts`                                                 | 8/8 passed                                                                                     |
| `pnpm exec vitest run tests/core-plugins.test.ts tests/umbrella-dependencies.test.ts`                 | 29 + 4 passed; the plugin suite now prints NVDEP001/NVDEP002 once                              |
| `pnpm exec vitest run tests/ledger-script.test.ts`                                                    | 15/15 passed                                                                                   |
| `pnpm exec vitest run tests/pr-policy.test.ts`                                                        | 32/32 passed                                                                                   |
| `pnpm exec vitest run tests/release-gate.test.ts`                                                     | 21/21 passed (2 new refusal cases)                                                             |
| `node scripts/ledger.mjs --self-test`, `node scripts/ledger.mjs check`                                | passed; 925 requirements, 96 Done                                                              |
| `NESTVEXA_PACK_PROFILES=npm:init,npm:third-party NESTVEXA_PACK_PORT=4260 pnpm test:pack` (PowerShell) | exit 0: 30 tarballs, both new consumers passed (report `2026-11-14T12:34:24Z`, marked partial) |
| `NESTVEXA_PACK_PROFILES=pnpm:minimal,npm:minimal pnpm test:pack` (PowerShell)                         | exit 0: the existing profiles still run through the new loop                                   |
| `PR_TITLE='feat: release round 7' PR_BASE_SHA=bd921f3 node scripts/pr-check.mjs`                      | passed: 36 files, `@nestvexa/core` covered by `core-deprecation-warnings`                      |
| `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`                                          | exit 0                                                                                         |
| `pnpm exec prettier --check` on changed files                                                         | clean                                                                                          |

The first pack run failed in the third-party consumer: it type-checked
`NestExpressApplication`, which needs `@types/express`. The consumer now
types the small part of the Express app it uses, and the second run passed.

Not run on this branch: the full `pnpm test:pack` with the two `full`
consumers (up to about 19 minutes each on this host), the Linux CI matrix,
and the `pr-policy` and `ledger` jobs on GitHub.

## Merge notes for the coordinator

- `package.json`: four test files were appended to `test:unit`
  (`core-deprecation`, `ledger-script`, `pr-policy`,
  `umbrella-dependencies`), and `umbrella-dependencies` also to
  `test:security`. No script was added or renamed. Expect conflicts at the
  ends of those two strings; keep both sides.
- `.github/workflows/ci.yml`: two new jobs (`pr-policy`, `ledger`) were
  appended after `docker`. Nothing else in the file changed.
- `scripts/pack.mjs`: the consumer loop now iterates the
  `consumerProfiles` list, which adds the `npm:init` and `npm:third-party`
  profiles. `pnpm test:pack` takes several minutes longer.
  `NESTVEXA_PACK_PROFILES` runs a subset and then marks `pack.json` as not
  passed. A new `report.profiles` field is written.
- `scripts/release-check.mjs`: now requires the `init` and `third-party`
  consumers. Any `pack.json` from before this branch fails the release
  check until `pnpm test:pack` is re-run.
- The core deprecation warnings appear in the stderr of suites that call
  `definePlugin` or `new PluginRegistry()` (`tests/core-plugins.test.ts`).
  They are expected output, not failures.
- No root Playwright entries, no new dependencies and no lockfile change.
- Ledger rows to update: REL-004, MAINT-007, MAINT-010, MAINT-017,
  REVIEW-018 and LEDGER-025. The evidence paths are above. Each row keeps
  the remaining gaps listed in its section.
