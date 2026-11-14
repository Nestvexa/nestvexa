# Extensions and CLI, round 4

## EXT-014

Optional constrained offline action queue (spec 16.2). Branch
`r4-ext-offline-queue`. ADR: [0026 amendment](../../adr/0026-extensions-i18n-ui-ai.md).

### Implemented

- **Server allowlist** (`@nestvexa/offline/server`, `packages/offline/src/server/queue.ts`):
  `offlineActionAllowlist(definitions)` validates id, exact same-origin path,
  `POST`/`PUT`/`PATCH`, `form` or `action` (`@nestvexa/actions` `{ input }`)
  encoding and a literal `idempotent: true`. It refuses `DELETE`, safe methods,
  duplicates, accessor or unknown options, and ids or paths naming payments,
  purchases, checkout, refunds, transfers or deletion. It renders an escaped
  `<meta name="nv-offline-actions">`. `offlineServerAction(descriptor)` bridges
  only `@nestvexa/actions` descriptors declared `idempotent: true`. No change to
  `packages/core`, `packages/live`, `packages/client` or `packages/actions`.
- **Server dedupe**: `createOfflineReplayGuard({ allowlist, store?, ttlMs? })`.
  `run()` executes at most once per (identity scope, action, `Idempotency-Key`).
  Duplicates replay the stored 2xx outcome (`x-nestvexa-offline-replayed: 1`).
  The guard refuses: concurrent duplicates (`409 OFFLINE_IN_PROGRESS`), a reused
  key with another body (`422 OFFLINE_KEY_REUSED`), a scope that is not the
  session's (`403 OFFLINE_SCOPE_MISMATCH`), the offline header on a route that
  is not allowlisted (`403 OFFLINE_NOT_ALLOWED`), and missing or invalid keys
  (`400`). Failures and throws release the key. `MemoryOfflineReplayStore` is
  bounded, has a TTL (default and maximum 7 days), never evicts in-progress
  locks, and receives only SHA-256 digests. A pluggable `OfflineReplayStore`
  allows shared stores.
- **Browser queue** (`createOfflineQueue`, `packages/offline/src/index.ts`):
  - Only actions in the server meta with a literal `idempotent: true` can be
    queued (`NOT_ALLOWLISTED` otherwise).
  - Storage keys are `nv-queue:v1:<draftScope>:<requestId>`, the same identity
    namespace as drafts. Other identities' entries are purged on creation, and
    `announceLogout`/`listenForLogout` now clear `nv-queue` too.
  - Bounded (20 entries by default, max 100; 16 KiB per entry, max 256 KiB) and
    expiring (1 hour by default, max 24 hours). Expired entries are removed
    unsent and announced.
  - Records are revalidated on every read.
  - Secret-named fields (password, token, CSRF, session, OTP, card, key and so
    on) are refused. The CSRF token is never stored: it is read from
    `<meta name="nestvexa-csrf">` at each send.
  - Replay goes in order, one tab at a time (Web Locks), with the same request
    ID on every attempt, `redirect: 'manual'` and a per-attempt timeout.
    Network errors, timeouts, 408/425/429/502/503/504 and in-progress conflicts
    retry with exponential backoff. Any other failure, including redirects,
    halts the queue at that entry until the user discards it or tries again.
- **UI** (`attachOfflineQueue`):
  - `form[data-nv-queue]` capture drops CSRF and `data-nv-queue-never` fields.
    It refuses, and lets the form submit natively, when the action is not
    allowlisted, the form `action` does not match the path, or a filled
    password, file, `data-nv-sensitive`, secret-named or payment/OTP
    autocomplete field is present.
  - `[data-nv-queue-status]` gets `role="status"` and is written with
    textContent only.
  - `[data-nv-queue-list]` shows each entry's label, state, `<time>`, a Discard
    button, and Try again when the entry failed. Focus is kept in the list.
  - Messages and labels can be translated through `data-nv-queue-message-*`
    (with `-one` variants) and `data-nv-queue-label-*`.
  - Everything is built with DOM APIs, so it works under the strict CSP and
    never uses innerHTML.

### Tests

All tests run real browsers against the strict-CSP fixture server
(`tests/offline-support.ts`, now able to launch chromium, firefox or webkit, add
head markup and handle dynamic routes, on an ephemeral port). The queue fixture
(`tests/offline-queue-support.ts`) runs a real `createOfflineReplayGuard` behind
a CSRF check.

- `tests/offline-queue-server.test.ts` (security group, 13 tests, Node):
  - allowlist validation and refusals (non-idempotent, delete, payment,
    malformed), and escaped meta output;
  - actions bridge;
  - at-most-once execution and stored-outcome replay;
  - concurrent duplicates;
  - key reuse with another body;
  - non-allowlisted route carrying the replay header;
  - cross-identity scope;
  - key validation and passthrough;
  - key release after failure;
  - TTL expiry and memory bound;
  - hashed keys only;
  - option validation.
- `tests/offline-queue-security.test.ts` (security group, 10 tests, Chromium):
  - non-idempotent and unknown actions refused, with native submit;
  - path mismatch refused;
  - a tampered allowlist without a literal flag, or with `DELETE`/`GET`/`//`
    paths, is ignored;
  - secret-named programmatic fields refused;
  - filled password, payment, sensitive and file fields refuse the form and
    nothing is stored;
  - entry-count and byte bounds;
  - expiry dropped and announced, never sent;
  - another identity's entries purged and never sent;
  - server refuses a replay after the session identity changed;
  - logout purge;
  - tampered storage records dropped.
- `tests/offline-queue.test.ts` (integration group, 7 tests, Chromium):
  - form queueing without CSRF or never-fields, replayed with the current
    (rotated) CSRF token;
  - actions JSON envelope with PATCH;
  - ordered replay that halts at the first non-retryable failure and resumes
    after discard;
  - network abort and 503/429/409-in-progress retries with the same request ID;
  - redirect and CSRF failures are non-retryable, and the user can retry;
  - translated status and list, keyboard discard and focus management;
  - cross-tab sync through storage events.
- `tests/offline-queue-browsers.test.ts` (integration group, 3 tests): uses
  `context.setOffline(true)` to queue while offline, then
  `context.setOffline(false)` and checks that the entry replays exactly once
  with the same request ID. A duplicate delivery returns the stored outcome
  without running again, a reopened page sends nothing, and there are no CSP
  violations. It is parametrized over **Chromium, Firefox and WebKit**.
- `tests/offline-server.test.ts`: the browser export list now includes the
  queue exports.

Commands (worktree, after `pnpm --filter @nestvexa/offline... build`):
`pnpm exec vitest run tests/offline-queue-server.test.ts tests/offline-queue-security.test.ts tests/offline-queue.test.ts tests/offline-queue-browsers.test.ts tests/offline-drafts.test.ts tests/offline-server.test.ts tests/offline-snapshot.test.ts`.

Result: 7 files, 60 tests passed (Chromium, Firefox and WebKit for
`offline-queue-browsers`). The same files run in parallel once timed out WebKit
`page.click('#save')` while waiting for the stability check. That step now uses
implicit submission (`press('Enter')`); the rerun passed in all three browsers.
Also run: `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit` (after a
full `pnpm build`), `pnpm docs:build` and prettier on the changed files, all
clean. `pnpm size:check` was not run because `packages/client` is unchanged.

### Docs

- `packages/offline/README.md`: the queue and server API, the markup contract,
  and the privacy section, which replaces "no offline action queue".
- `docs/guides/offline.md`: section 8 (allowlist, guard, UI, refusal table,
  Playwright example).
- `docs/adr/0026-extensions-i18n-ui-ai.md`: the amendment (threat model and
  decisions).
- `.changeset/offline-action-queue.md` (minor).

### Root package.json

- `test:integration` += `tests/offline-queue.test.ts tests/offline-queue-browsers.test.ts`.
- `test:security` += `tests/offline-queue-server.test.ts tests/offline-queue-security.test.ts`.
- No Playwright config entry: the browser test is vitest-driven and uses its
  own ephemeral-port fixture.

### Remaining gaps

- No example app wires the queue. Coverage comes from the fixture-based tests.
- No background sync or service worker: replay happens only while a page that
  created the queue is open.
- The default replay store is per process. Multi-replica hosts must supply an
  atomic shared `OfflineReplayStore`. No Redis implementation is shipped.
- For `offlineServerAction` routes, deduplication comes from the
  `@nestvexa/actions` idempotency store. The offline scope check applies only
  if the host also calls `guard.check()` in front of them, and no test covers
  an actions route end to end.
- Field-name secret detection is a heuristic word list. Hosts must still mark
  unusual sensitive fields `data-nv-sensitive`.
- Firefox and WebKit run only the offline-to-online replay test. The other
  queue suites run in Chromium.

## Items 3–8: CLI (EXT-030, EXT-027/028, DX-016, DX-017/018, DX-027, DX-030/031, EXT-032)

Branch `worktree-agent-a38e7b1dfb9f2c698`, started from main `acf4168`; main was
merged in before the final checks. Scope: items 3–8 of the round 4 brief.
EXT-014 (offline queue) and EXT-017 (UI kit wrappers) belong to other agents.
`packages/offline`, `packages/ui` and the core extension API were not changed.

Package touched: `@nestvexa/cli` (changeset
`.changeset/cli-routes-crud-format-plugins.md`, minor). Example regenerated:
`examples/cli-generated`. Root devDependencies added (pinned, exact):
`typeorm` 1.1.2, `@nestjs/typeorm` 12.0.2 (12.0.3 is younger than the
workspace `minimumReleaseAge`), `sql.js` 1.15.2, `jest` 30.5.2 and
`@jest/globals` 30.5.2.

The host was very heavily loaded during this round (one `tsc -p` of the CLI
took 5–7 minutes, and parallel suites were killed with exit 134/143). The
"Verification" section lists only what actually ran, and what result it got.

### EXT-030: typed routes and link helpers

- New command `nestvexa routes:types [--check] [--dry-run]`
  (`packages/cli/src/routes.ts`). It finds every statically declared
  controller route with the TypeScript AST. It handles `@Controller('x')`,
  `@Controller({ path })` and array paths (the first path is used, as
  `routesFromControllers` does), and `@Get/@Post/@Put/@Patch/@Delete`. It writes
  `src/nestvexa/routes.ts`, which imports nothing, so the server and every
  frontend root can use it:
  - `routes`: a typed `as const` map. Names are `ControllerClass.method`, the
    default names of `routesFromControllers` in `@nestvexa/views`.
  - `RouteParams`: the path parameters of each route. `:id` is required,
    `{/:x}` is optional, and `*path` accepts a value or an array.
  - `RouteArgs<Name>`: `params` is optional only when no path parameter is
    required.
  - `route(name, params)`: the same rules as `RouteTable#url`. Each segment is
    percent-encoded; `.`/`..`, missing and non-scalar values are refused; unused
    keys become the query string; `__proto__` is ignored.
  - `routeLink(name, params)`: returns `{ href, method }` (method in lower case),
    spread onto Inertia's `Link` in React, Vue (`v-bind`) and Svelte.
  - `isRouteName`.
- The first run also writes `src/nestvexa/route-helpers.ts`. It holds a
  `routeTable` (a `RouteTable` over the same map) and
  `configureRouteHelpers(app)`, which registers `{{route "Name" id=1}}` with the
  umbrella Handlebars engine. The first run also inserts that call into
  `main.ts` before `configureNestvexa`.
- Patterns that `RouteTable` cannot reverse (regular expressions) are skipped
  with a note. A duplicate controller class name is refused. `--check` exits 1
  when the map is stale, and compares against the formatted output.
  `inspect:routes` now shares the same route collection.
- Tests: `tests/cli-routes.test.ts`, on an ESM fixture with React, Vue and
  Svelte roots and port 3970. It covers:
  - generation, dry run, `--check`, idempotency and the skipped pattern;
  - a usage file that must compile, and a misuse file whose four
    `@ts-expect-error` lines must be errors: an unknown name, a missing `id`, an
    object `id`, and the wrong method literal;
  - Inertia `Link` usage type-checked with `tsc` (React), `vue-tsc` and
    `svelte-check`;
  - runtime equality of `route()` with `RouteTable#url` across seven cases,
    plus negative cases (unsafe segment, missing parameter, unknown name,
    `__proto__`, object query value);
  - the booted app rendering `{{route}}` links in Handlebars, and the rendered
    link resolving to a real route;
  - stale-map detection after a route changes.
- Example: `examples/cli-generated` runs `routes:types` (`src/nestvexa/routes.ts`,
  `route-helpers.ts`, `configureRouteHelpers(app)` in `main.ts`).
- Docs: CLI reference and README (commands table, Limits).
- Remaining gaps:
  - Global prefixes, versioning and routes registered at runtime are not in the
    map.
  - The `route` helper is registered only for Handlebars. EJS, Pug and Nunjucks
    can use `routeTable.url()` as a local.
  - Permission-aware helpers already exist in `@nestvexa/views`
    (`permissionHelpers`) but are not generated.
  - The map is not regenerated automatically after `make:page` or
    `make:resource`.

### EXT-027 / EXT-028 / DX-016: CRUD DTOs, validation, tests, real ORM

- `make:resource <Name> [--crud] [--orm memory|typeorm]`
  (`packages/cli/src/templates-resource.ts`, catalog ids `resource.*`) generates:
  - `<name>.dto.ts`: Zod `strictObject` schemas for create, update (partial) and
    the list query. The query has `q`, a 1-based `page` and `size` ≤ 100, with
    coercion. It also exports `@nestvexa/forms` adapters, which the REST
    controller and the Live table share.
  - `<name>.repository.ts`: the `<Name>Repository` interface (the selectable
    "ORM interface") and its injection token.
  - `<name>.memory-repository.ts`: always generated; tests use it.
  - With `--orm typeorm`: `<name>.entity.ts` and `<name>.typeorm-repository.ts`,
    with `findAndCount`, a bound `Like` search and `findOneBy`/`save`/`delete`.
    No migration and no `synchronize` are generated, and the command prints
    that the app must register its own `TypeOrmModule.forRoot`.
  - The service: asynchronous, with `NotFoundException` on a missing record. The
    module binds the chosen repository; the TypeORM variant adds
    `TypeOrmModule.forFeature`.
  - With `--crud`: a REST controller using `FormValidationPipe`. Routes: list
    (search and pages), show, create, update and delete (204). Invalid input
    returns 400 with field errors.
  - A Live table: search (`nv:model.live.debounce`), Previous/Next pages, and a
    validated create with an accessible error. The rows are loaded in
    `beforeRender`, so they are not part of the client state.
  - Generated tests: DTO and service tests always, and an HTTP controller test
    with `--crud`. They use vitest, or `@jest/globals` when the project uses Jest.
  - Dependencies: `@nestvexa/forms`, `zod`, and for TypeORM `typeorm` and
    `@nestjs/typeorm`, all pinned. The test runner and `@nestjs/testing` are
    added as devDependencies.
- Other ORMs exit 2 with an instruction to implement the repository interface.
- Breaking for generated code: `GET /<resource>` returns
  `{ items, total, page, size }`, and the service is asynchronous.
- TypeORM was chosen because it is the official NestJS integration
  (`@nestjs/typeorm`). Prisma would need a generated client and an engine
  download, which tests cannot do offline.
- Tests:
  - `tests/cli-resource.test.ts` covers:
    - generation of both variants and the exact file list, refusal of `--orm prisma`, idempotency, pinned dependencies, module and Live registration;
    - the app compiling under strict TS, and its generated tests passing (eight
      files);
    - the TypeORM module served on **sql.js**: validation errors, unknown keys
      refused, trimming, search with pages, a SQL-injection-shaped search
      returning nothing, PATCH, DELETE, 404s, and a 400 for an id that is not a
      number.
  - `tests/cli-generators.test.ts` and `tests/cli-fastify.test.ts` were updated
    for the new list shape and seven generated test files.
  - `tests/browser/cli-generated.spec.ts`: the Live table search and pages
    summary, the `aria-invalid` error, the REST search, and a 400 on an invalid
    body.
- EXT-028: the generated resource now carries search, filter and page
  primitives. Still missing: a reusable package-level search/filter primitive
  and multi-tenant or admin starters as CLI scaffolds.
- Remaining EXT-027 gaps:
  - The Live table has no per-row edit or delete (REST has both).
  - The TypeORM Live table is compiled but not run in a browser.
  - There is no Prisma or Drizzle generator.

### DX-017 / DX-018: Vue and Svelte islands and the Jest variant

- DX-017:
  - `examples/cli-generated` now generates `make:island Feed --renderer vue`
    and `Status --renderer svelte` next to the React island. The showcase mounts
    all three.
  - The example build (`build:islands`) bundles them, and
    `tests/browser/cli-generated.spec.ts` clicks each one.
  - `tests/cli-generators.test.ts` now also type-checks the islands with
    `vue-tsc` and `svelte-check`.
- DX-018:
  - `make:test` adds `@jest/globals` (pinned) for Jest projects.
  - `tests/cli-jest.test.ts` builds an ESM fixture that declares Jest. It
    generates component, page, form, action and smoke tests, plus the resource
    tests, and compiles all of them. It then runs the seven unit and HTTP
    suites with Jest's native ESM mode (`--experimental-vm-modules`,
    `transform: {}`).
  - Gap: CommonJS + `ts-jest` projects cannot import the ESM-only Nestvexa
    packages under Jest's CommonJS runtime. This is documented in Limits.
  - Gap: the generated e2e smoke test (`make:test --kind smoke`) boots
    `AppModule` without the `main.ts` setup (sessions, `configureNestvexa`). A
    Live page such as `/nestvexa` therefore answers 500 there. It is compiled
    but not run, in both the Jest and the vitest suites. The fix (sharing a
    bootstrap function between `main.ts` and the test) is left for a later
    round.

### DX-027: package-manager detection and doctor tests

- `detectPackageManager` (exported) checks, in order:
  1. the Corepack `packageManager` field, which is validated;
  2. a lockfile in the project (`pnpm-lock.yaml`/`pnpm-workspace.yaml`,
     `yarn.lock`, `bun.lock` (new), `bun.lockb`, `package-lock.json`,
     `npm-shrinkwrap.json`);
  3. the same lockfiles in an enclosing workspace, up to a `.git` boundary and
     at most eight levels;
  4. npm.
- `supportedNode` is extracted and exported.
- Effect: fixtures inside this pnpm workspace now resolve to pnpm.
  `tests/cli-generators.test.ts` expects `pnpm run ...` scripts and the
  `build --dry-run` text.
- `tests/cli-doctor.test.ts` (`test:unit`, `test:security`) uses synthetic
  projects in the OS temp directory, with package.json files under
  node_modules only. It covers:
  - every lockfile and the `packageManager` field (including an unknown
    manager);
  - a workspace lockfile above a workspace package, and the `.git` boundary;
  - the detected manager in `build`, `add` and doctor hints;
  - all doctor checks: node versions; nest (missing, outdated, fastify);
    platform; nestvexa; peers (pass with an optional peer, range mismatch,
    missing required peer, declared but not installed); versions warn;
    client-duplicates fail; layout (warn, missing); engines (fail, warn, pass);
    configure; session (Express, Fastify); csrf (`csrf: false`,
    `requireAuthorizedActions: false`, cookie flags); session-secret (literal in
    development and production, short, unset in production); origin (invalid,
    http in production, `NODE_ENV=production`); realtime-secret (literal, pass);
    redis (malformed); assets (missing roots and SSR bundle, production fail,
    pass).
  - Secret values are asserted never to appear in the output.
- Gap: the Nest compiler (`nest-cli.json` builder swc or webpack) is still not
  detected.

### DX-030 / DX-031: project formatter and linter

- `packages/cli/src/format.ts` runs when the project declares `prettier` and/or
  `eslint` and they resolve from the project. On every command that writes
  files, before the plan is applied, it runs ESLint `--fix` (generated files
  only), then Prettier, with the project's own configuration. This happens in a
  child Node process, because both tools are asynchronous.
  - Created and previously generated files are always formatted. Other edited
    files are formatted only if they were Prettier-clean before, so unrelated
    lines of an unformatted user file never change.
  - `.prettierignore`, `.gitignore` and ESLint ignores are honored.
  - It is best effort. A broken or missing tool, a parse error or remaining lint
    problems become notes; the command never fails because of them.
    `--no-format` opts out.
- `ChangePlan` now resolves generator conflicts after formatting
  (`conflict` / `resolveConflicts`). A re-run whose formatted output equals the
  file is a no-op, and manifest checksums are those of the formatted output, so
  `remove` still works.
- The `make:form` view (template v2) and the resource view no longer put
  Handlebars blocks inside tags, which Prettier's HTML parser cannot parse.
- Tests: `tests/cli-format.test.ts`. The fixture uses `semi: false`, double
  quotes and an ESLint `curly` rule. It checks:
  - created files are formatted, while the unformatted `main.ts` keeps its line;
  - the ESLint fix runs before Prettier;
  - re-runs are idempotent, edited files are still conflicts, and `remove`
    works;
  - `.prettierignore` and `--no-format` are honored;
  - `routes:types --check` agrees with the formatted map, and the result
    compiles;
  - a broken Prettier or ESLint package and tools that are declared but not
    installed never fail generation.
- Example: the bare app in `scripts/generate-cli-example.mjs` declares Prettier
  (like `nest new`), so the CLI formats the example with the repository's
  configuration. The script also formats its hand-written parts.
  `examples/cli-generated` was removed from `.prettierignore` (see
  Verification).
- DX-031 gap: templates are customizable and versioned (earlier rounds). Vue
  and Svelte files are formatted only if the project's Prettier has the needed
  plugins.

### EXT-032: `add` and the public extension API

- `nestvexa add plugin <package> [--export <name>]` (`packages/cli/src/plugins.ts`)
  uses only public API: `NestvexaExtension`, `CoreModuleRegistration` and
  `NestvexaModule.forRoot(options, live, kernel)`.
  - The package must be a valid npm name. Paths, URLs, git and `file:`
    specifiers exit 2.
  - It must be declared in `package.json` and installed. The CLI never
    downloads anything.
  - Its `nestvexa` manifest is read as JSON and validated with the rules of
    `parsePluginManifest`: allowed keys, name and version equal to the installed
    package, capabilities from `PLUGIN_CAPABILITIES`, and a range that includes
    the installed `nestvexa`. The plugin code is never executed.
  - It generates `src/nestvexa/extensions.ts` (`nestvexaExtensions`,
    `nestvexaKernel`) and passes `nestvexaKernel` as the third `forRoot`
    argument. Running it again is idempotent, and `--export` adds more exports.
- Tests: `tests/cli-plugins.test.ts` (`test:integration`, `test:security`,
  port 3971). It checks:
  - the CLI capability list equals core's `PLUGIN_CAPABILITIES`;
  - every refusal: specifiers, undeclared, not installed, no manifest, name or
    version mismatch, range, capabilities, an unknown key, an invalid
    `--export`. Nothing is written in any of these cases;
  - dry run, wiring, idempotency and a second export;
  - the plugin's import-time marker is absent after `add`;
  - the app compiles, and booting it runs `register()`.
- Unified extension API (kernel round 4, merged from main): `NestvexaExtension`
  now carries `version` and a `nestvexa` range that the host checks at
  startup, and `PluginRegistry` is a deprecated adapter. `add plugin` wires
  extensions into `CoreModuleRegistration.extensions`, the single runtime path.
  With `--legacy-plugin`, a deprecated `NestvexaPlugin` export is wrapped with
  core's `pluginExtension()`. The test boots both an extension (with
  `version`/`nestvexa`) and a legacy plugin, whose `setup` runs through the
  extension host.
- Remaining:
  - The manifest has no field naming the export (`--export` covers it).
  - Installation is not recorded in the CLI manifest.
  - The CLI cannot tell statically whether an export is an extension or a
    legacy plugin; `--legacy-plugin` is explicit, and `tsc` catches a wrong
    choice.

### Verification

Main was merged three times; the last merge brought in `928b2f1`. The
commands below were run one test file at a time, on the merged tree, unless a
line says otherwise.

- `pnpm --filter "./packages/**" build`: pass (30 packages).
- `pnpm exec vitest run tests/cli-doctor.test.ts`: 13/13 (on the first merge;
  the later merges did not change the CLI).
- `tests/cli-plugins.test.ts`: 4/4 after the kernel round 4 merge, including
  the `--legacy-plugin` boot.
- `tests/cli-resource.test.ts`: 3/3.
- `tests/cli-jest.test.ts`: 2/2.
- `tests/cli-routes.test.ts`: 5/5.
- `tests/cli-format.test.ts`: 6/6.
- `tests/cli-example.test.ts`: 2/2, after the regeneration that followed the
  kernel merge.
- `pnpm --filter @nestvexa/example-cli-generated build`: pass. This covers the
  server, React/Vue/Svelte client and SSR builds, and the islands bundle with
  the Vue and Svelte islands.
- `pnpm exec playwright test -c playwright.local.config.ts cli-generated.spec.ts --project=chromium`:
  7/7 on port 3973. The example's port is overridable through
  `NV_CLI_GENERATED_PORT`, which the root suite does not set.
- `pnpm lint`: pass.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: pass.
- `pnpm format:check`: three files were reported and then formatted
  (`88364c2`); `prettier --check` on them now passes.
  `examples/cli-generated` passes without a `.prettierignore` entry.
- Not run because of host load: Firefox and WebKit for the example;
  `tests/cli-generators.test.ts`, `tests/cli-fastify.test.ts`, `tests/cli.test.ts`
  and `tests/cli-inertia-ssr.test.ts` (their expectations were updated for the
  new list shape, the seven generated test files and pnpm scripts);
  `pnpm docs:build`.
