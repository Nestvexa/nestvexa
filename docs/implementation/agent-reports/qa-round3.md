# Agent report: QA round 3

Branch: `worktree-agent-a24028117735b20e0` (from `acf4168`). Date: 2026-11-07.
Ledger group QA. No ledger, progress, STATUS or final report file was edited.
The work was interrupted once by a session restart and finished in a second
session on the same worktree.

## Summary

1. **Browser-runtime fuzzing** of the Live client:
   `tests/property-client-runtime.test.ts` (fast-check in Node, every case
   evaluated in a real browser against the built `packages/client/dist`).
2. **Mutation testing**: StrykerJS 10.1.1 (`@stryker-mutator/core`,
   `@stryker-mutator/vitest-runner`, exact versions checked with `npm view`),
   `stryker.config.mjs`, `vitest.mutation.config.ts`, `pnpm test:mutation`,
   and a new admission suite written for it (`tests/live-admission.test.ts`).
3. **Nightly workflow**: `.github/workflows/nightly.yml`.
4. **Run budget**: `tests/support/property-runs.ts`
   (`NV_PROPERTY_RUNS_MULTIPLIER`, 1–100, invalid values fail) used by all
   nine property suites; `tests/property-runs.test.ts`.
5. **Server-side mount memory bounds**: `tests/live-memory.test.ts`.
6. Docs: `docs/testing/property-load-mutation.md` (browser fuzzing, run
   multiplier, mutation testing, nightly).

## Per ledger row

### QA-056: property-based testing (browser runtime)

Round 1 left "idempotent morph invariants (browser runtime) not covered".
Now covered by `tests/property-client-runtime.test.ts`, which runs in Chromium
by default and in Firefox/WebKit with `NV_FUZZ_BROWSERS`. Five properties:

- **Directive grammar**: generated `nv:` names (known and unknown bases,
  modifiers, unicode, malformed prefixes) and hostile values. `parseDirective`
  returns plain JSON or throws `DIRECTIVE`, is deterministic, and accepts only
  known bases.
- **Fragment safety**: plain and hostile fragments (script-capable elements,
  foreign namespaces, real `on*` handlers, `srcdoc`, executable URLs hidden
  with entities/tabs/newlines/control characters/`&colon;`/mixed case).
  Whatever the browser would treat as active content (judged by the WHATWG URL
  parser and the element's own handler properties, not by client code) is
  rejected with `HTML`. Nothing active reaches the live DOM, and the `nvPwn()`
  sentinel never fires. The page has no CSP on purpose, so a handler that got
  through would run and be recorded.
- **Morph invariants**: the morph rejects duplicate sibling keys with `HTML`
  and leaves the DOM unchanged. Otherwise the result is `isEqualNode` to the
  server fragment, keyed nodes keep their identity, and a second identical
  morph makes zero `MutationObserver` records (idempotence).
- **Hostile replies through `createLiveClient`**: transport faults (non-2xx,
  426, wrong content type, invalid JSON or UTF-8, foreign protocol header,
  oversized body) and envelope mutations (request ID, revision, ID or name
  mismatch, unsafe redirects, invalid events, downloads, realtime tokens and
  snapshots, bad state keys, `__proto__`, renderless with HTML, arbitrary field
  replacement). Each reply either applies atomically (DOM, snapshot and
  revision markers, and state all equal the reply) or is rejected with a
  classified error and changes nothing. Well-formed plain replies must apply.
  The page never navigates and `Object.prototype` stays clean.
- **Mount fuzz**: random owned directives, then click/keydown/input/change on
  every element. `mount()` never throws, requests go only to same-origin
  `/_live/fuzz/<identifier>`, and no uncaught page error occurs.

Oracle fix made in this session: a reply may legitimately replace public state
with one that has no `count` field, so the oracle now reads `count` through a
helper that maps the client's `DIRECTIVE` error to `undefined`. This was an
oracle bug, not a client bug. The suite also opens a fresh page per property
and has generous launch, navigation and hook bounds for slow Firefox/WebKit
starts.

No client defect was found. Evidence is under "Test commands" below.

### QA-073: security/chaos/fault injection (client side)

Partly addressed by the hostile-reply and transport-fault properties above:
malformed, oversized, wrong-type and tampered server replies are injected at
the `fetch` boundary. This is not distributed fault injection: no network
partitions and no server crash during commit.

### QA-078 / QA-079: mutation coverage

- StrykerJS 10.1.1, pinned and checked with `npm view`. `pnpm test:mutation`
  uses `stryker.config.mjs` (full high-risk scope: Live protocol, snapshot
  store, Live admission in `runtime.ts`, core config, uploads
  filename/references/file-types) and `vitest.mutation.config.ts` (seven
  suites; `dist` imports of core/live/uploads are redirected to the sources).
- New `tests/live-admission.test.ts` (unit, 60+ cases): origin exactness,
  content-type grammar, identity length bounds and types, constant-time CSRF
  (missing, empty, same-length wrong, prefix, longer, array), the rate limit
  (exact count, 60-second window edge, default 60, 1000-identity cap),
  protocol and capability errors, snapshot component/identity mismatch, the
  action allowlist (`constructor`, `__proto__`, state names) and `$sync`,
  authorization denial, and shutdown before and during identity resolution.
  It imports the TypeScript sources so the mutants are seen.
- Recorded score (narrowed local run, 2026-11-07, 67 minutes on a host at
  100% CPU): **82.74% overall** (585 killed, 113 survived, 9 no coverage,
  1 runtime error; 38 static mutants ignored). By file: Live `protocol.ts`
  82.02%, Live admission in `runtime.ts` 92.36%, uploads `filename.ts` 81.21%,
  `references.ts` 71.60%. The full configured scope (adding `store.ts`,
  `core/src/config.ts` and `file-types.ts`) was too slow on this host and was
  stopped: the dry run took about 7 minutes and the first mutants ran at about 6
  per minute. It runs in the nightly job, and its score is **not recorded**
  here. Tests added after the run target the killable admission survivors (no
  headers object, array content-type, shutdown during authorization); the run
  was not repeated to measure their effect. The score is reported, not gating.
  A setup incident is fixed in the config: Stryker's default
  `disableTypeChecks` added `// @ts-nocheck` banners to about 1,500 working
  files in `inPlace` mode. The files were restored byte-for-byte from Stryker's
  backup, and the config now sets `disableTypeChecks: false`.

### QA-089: nightly pipeline

`.github/workflows/nightly.yml` (schedule `17 3 * * *` and manual dispatch;
`contents: read`; uses only `actions/checkout@v4`, `pnpm/action-setup@v4`,
`actions/setup-node@v4` and `actions/upload-artifact@v4`, all already used in
the repo). Jobs:

- three-browser e2e matrix over the root Playwright config;
- property suites with `NV_PROPERTY_RUNS_MULTIPLIER=10` and the browser fuzz in
  all three engines;
- the full `test:security`;
- mutation testing over the full scope (reported, not gating);
- `pnpm load` with a 10-minute soak (latency advisory, correctness and memory
  gates enforced);
- `pnpm audit --audit-level high` and an informational `pnpm outdated`.

Every job uploads its reports. The YAML parses (PyYAML), and the action
allowlist was checked by script. It has not run on GitHub from this branch.

### QA-007: bounded memory, no leaks after thousands of mounts (server)

Round 1 noted "not thousands of mounts per process". The new
`tests/live-memory.test.ts` (integration) drives 3,200 mounts in one process
through the real `LiveRuntime` and a cached Handlebars engine, each mount for a
fresh identity:

- The default `MemoryLiveStore` fails closed at its entry budget (503
  `STORE_CAPACITY`, no eviction of live components) and recovers once entries
  expire, over five 200-entry windows. The fake clock also resets the runtime's
  1,000-identity rate-limit buckets.
- Revocation releases every entry. Over four cycles of 500 mounts, the heap
  retained after forced full GC grows less than 8 MiB from baseline and less
  than 4 MiB between cycles 2 and 4.

Client-side listener/node leak checks already exist from another round
(`tests/client-runtime-resilience.test.ts`, "memory: listeners and nodes stay
bounded"). Finding: with the development renderer (`cache` off), one mount
took 150–250 ms on this saturated host. A CPU profile shows mostly idle wait on
file-system calls (`realpath`/`stat` while resolving the view), not CPU. With
`cache: true`, as in this suite, the revocation test averaged about 4 ms per
mount. Neither number is a performance claim.

### QA-013 / QA-077: performance and load in CI

`pnpm load` now runs nightly with a 10-minute soak, and `artifacts/reports/load.json`
is uploaded. No new local load run was made here because the host was at 100%
CPU from parallel agents.

### QA-081: practical timeouts, no masking

The property run budget (`tests/support/property-runs.ts`) scales every
fast-check suite by `NV_PROPERTY_RUNS_MULTIPLIER` (an integer from 1 to 100;
invalid values throw instead of silently running the baseline;
`tests/property-runs.test.ts`). The browser fuzz timeout scales with the
multiplier. No retries were added.

### QA-092: machine-readable reports

Mutation reports go to `artifacts/reports/mutation/{index.html,mutation.json}`.
Each nightly job uploads its artifacts.

### Not addressed

- QA-075 (axe): already covered by 24 browser specs that use
  `@axe-core/playwright`; nothing new added.
- QA-071 (compatibility matrix): `ci.yml` already has an OS × Node matrix; not
  changed.
- QA-015/016/018 (distributed faults, retry budgets, SSE backpressure): not
  concretely testable within this scope; unchanged.

## Test commands (Windows 11, Node 24.13.0, host at 100% CPU from parallel agents)

- `NV_PROPERTY_RUNS_MULTIPLIER=5 pnpm exec vitest run tests/property-client-runtime.test.ts`
  (Chromium, 5x runs): 5/5 passed in 178 s.
- Final Chromium run at 1x after the last fixture change: 5/5 passed.
- `NV_FUZZ_BROWSERS=firefox,webkit …`: all 5 passed in WebKit. Firefox first
  timed out in the launch hook, which led to the per-property page and the
  longer bounds. `NV_FUZZ_BROWSERS=firefox …` then passed 5/5 (438 s).
- `pnpm exec vitest run tests/live-admission.test.ts`: 52/52 passed.
- `pnpm exec vitest run tests/property-runs.test.ts`: passed.
- `pnpm exec vitest run tests/live-memory.test.ts`: 2/2 passed (68 s).
- `pnpm exec vitest run -c vitest.mutation.config.ts` (the mutation test
  command, unmutated): 7 files, 245 tests passed.
- `pnpm exec stryker run stryker.config.mjs --mutate <protocol, admission,
filename, references>`: 82.74% (above). Two earlier full-scope attempts
  were stopped or failed: the first because of the `@ts-nocheck` incident, the
  second because a Nest DI test timed out at 30 s in the dry run on the loaded
  host (now 120 s, with `dryRunTimeoutMinutes: 30`). A third, at five files,
  was stopped as too slow.
- `.github/workflows/nightly.yml` parsed with PyYAML; action allowlist checked.
- `pnpm exec eslint` on all changed and new files: clean.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: passed. The first run found
  that `fc.letrec` fell back to its loosely typed overload with an interface;
  the fix was a type alias.
- `pnpm exec prettier --check` on changed files: clean after `--write`.
- `pnpm docs:build`: passed (220 documents, 1310 API symbols).
- Full `pnpm lint`, `pnpm build` and the complete suites were not rerun on this
  saturated host; only the targeted files above were run.

## Notes for the coordinator

- Root `package.json`: devDependencies `@stryker-mutator/core@10.1.1` and
  `@stryker-mutator/vitest-runner@10.1.1`; new script `test:mutation`.
  `tests/live-admission.test.ts` and `tests/property-runs.test.ts` are appended
  to `test:unit`, `tests/live-memory.test.ts` to `test:integration`,
  `tests/property-client-runtime.test.ts` and `tests/live-admission.test.ts`
  to `test:security`, and `tests/property-client-runtime.test.ts` to
  `test:property`. Expect conflicts on these long script lines.
- `pnpm-lock.yaml` changed (the two Stryker packages).
- `.gitignore`: `.stryker-tmp/`.
- The browser fuzz needs `pnpm --filter @nestvexa/client build` first. It
  starts its own static server on an ephemeral 127.0.0.1 port; no Playwright
  config entry is needed.
- No changeset: no published package changed (tests, CI and docs only).
- Do not hard-kill `pnpm test:mutation` (it mutates sources in place); Ctrl+C
  restores them.
