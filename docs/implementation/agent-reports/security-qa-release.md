# Agent report — security hardening, QA depth and release engineering

Branch: `worktree-agent-a5133b98560ed2323` (from `d4c4cec`). Dates: 2026-11-05/06.
Ledger groups SEC, QA, REL, MAINT, LEDGER. No ledger/progress/STATUS/final
report file was edited. Nothing was versioned, tagged, pushed or published.

## Summary of delivered work

1. **Property-based/fuzz tests** (fast-check 4.10.2, exact root devDependency):
   eight suites, `pnpm test:property`, also appended to `test:security`:
   `tests/property-live-protocol.test.ts`, `property-realtime-token`,
   `property-uploads`, `property-uploads-http` (real Express multipart/raw
   routes), `property-view-paths` (HBS/EJS/Pug/Nunjucks), `property-input-admission`
   (actions JSON admission, output, fingerprints, forms, log redaction),
   `property-i18n`, `property-inertia` (headers, every redirect validator,
   script JSON).
2. **Fixes found by the review** (each with regression tests and a changeset):
   - IR-01 views/engine-hbs: U+10FFFF in a view path aborted the Windows Node
     process (libuv assertion); controls, unpaired surrogates and
     noncharacters are refused before any fs call.
   - IR-02 engine-ejs: EJS's built-in include probed `fs.existsSync` with raw
     references before containment (existence oracle, UNC/SMB on Windows,
     U+10FFFF abort); the adapter now owns `include`.
   - IR-03/04 inertia: `/\host` request paths became off-origin
     `X-Inertia-Location`; non-ASCII redirect targets crashed the reply.
   - IR-05 uploads: lone surrogates in filenames → 500 on download; pair split
     on truncation.
   - IR-06/07 live: corrupted download media-type regex (`$&` artifact);
     lone-surrogate and bidi download filenames.
   - IR-08 realtime: `MemoryRealtimeBroker` replay history unbounded across
     channels (`replayChannels`, default 10,000).
   - IR-09 observability: `redact()` lost own `__proto__` fields (prototype
     replaced).
   - Open P3: IR-10 (actions inspection stack pre-push), IR-11 (host code and
     the upstream Windows U+10FFFF abort).
3. **Load/memory**: `scripts/load.mjs` + `scripts/load-probe.mjs`, `pnpm load`
   (autocannon 8.0.0); evidence `docs/implementation/load-evidence-2026-11-05.json`.
4. **Release engineering**: Changesets fixed group; `pnpm release:prepare`;
   CycloneDX 1.6 SBOM per tarball (`scripts/sbom.mjs`, wired into
   `scripts/pack.mjs`); `.github/workflows/release.yml` (manual, matrix,
   verification, protected environment, npm trusted publishing with
   provenance); `scripts/release-matrix.mjs`, `scripts/release-publish.mjs`;
   `.github/dependabot.yml`; per-path `.github/CODEOWNERS`; SECURITY/SUPPORT/
   GOVERNANCE; `docs/release/*`.
5. **release-check**: gates added only (SBOM verification, single version,
   stricter matrix/security-review formats, enforced load report).

## Per ledger row

States below are proposals for the coordinator; "partial" means evidence was
added but the row's full requirement is not met.

### SEC

- **SEC-001/SEC-002** (blocking security gate, ASVS mapping, trust
  boundaries): partial. `docs/security/internal-review-2026-11.md` (per-package
  boundaries, findings), threat model rows for view paths, request-derived
  headers, realtime memory and the release pipeline; ASVS additions incl.
  v5.0.0-15.1.1/15.1.2/15.2.2/15.3.3/15.3.6 (checked against the tagged
  upstream chapter). Property suites are in `test:security`. `release-check`
  now requires an independent reviewer. Gap: no independent review; threat
  model diagrams unchanged.
- **SEC-004** (attacker capabilities): partial. Forged/corrupted messages,
  injection strings, hostile files and high volume exercised by the property
  and HTTP fuzz suites and `pnpm load`.
- **SEC-009** (state integrity): partial. Snapshot token canonicality and
  realtime token tamper/identity/expiry/rotation properties
  (`property-live-protocol`, `property-realtime-token`). No change to binding.
- **SEC-010** (actions allowlist, prototype pollution, depth/size): evidence
  added. `property-input-admission` (reference model; 50,000-deep JSON;
  accessors; no global pollution); Live envelope model in
  `property-live-protocol`. Open P3 IR-10.
- **SEC-011** (escaping, script JSON, URL schemes): evidence added for Inertia
  script JSON, i18n escaping and redirect URL policies (`property-inertia`,
  `property-i18n`). Browser runtime not fuzzed.
- **SEC-013** (uploads): fixes IR-05; `property-uploads`,
  `property-uploads-http` (no 5xx, valid names only, no temp leaks).
- **SEC-014** (transport): IR-08 fix; hub churn of 20,000 connections in
  `pnpm load` (0 open after, 0.60 MiB heap growth).
- **SEC-016** (supply chain): SBOM per tarball, provenance via trusted
  publishing, Dependabot (no auto-merge), protected release environment,
  CODEOWNERS on release paths, audit in release job. Gap: secrets scanning and
  license audit are GitHub settings/owner steps (documented in
  `docs/release/release-process.md`), not executed here.
- **SEC-017** (logging/privacy): IR-09 fix; redaction property test.
- **SEC-020** (forged/tampered snapshot): token canonicality properties.
- **SEC-021** (mass assignment, proto pollution): Live/actions/forms properties.
- **SEC-022** (script closing in page JSON): `property-inertia` script JSON.
- **SEC-024** (malformed `X-Inertia` headers, redirect injection): headers and
  every redirect validator property-tested; IR-03/04 fixed.
- **SEC-025** (upload traversal/mime/size): filename/traversal properties and
  HTTP multipart fuzz.
- **SEC-026** (oversized/recursive JSON): exact budget model for Live; deep
  JSON for actions; form limits.
- **SEC-029** (SSRF, dynamic imports, view traversal): view traversal fuzzed
  through all engines, IR-01/02 fixed; source review found no request-controlled
  outbound URL (internal review). Dynamic imports not reviewed in depth.
- **SEC-031** (security docs): threat model, ASVS, hardening, SECURITY.md
  (supported-version policy and disclosure timelines) updated; new internal
  review document. No "unhackable" claims.

### QA

- **QA-007** (bounded memory, no leaks after thousands of mounts): partial.
  `pnpm load`: 300 fresh mounts + 4,673 serial actions over 400 sessions in a
  3-minute soak, heap 24.4 → 24.3 MiB (slope 0.05 MiB/min). Not "thousands of
  mounts" per process because the example's store is capped at 1000 per TTL.
- **QA-013 / QA-077** (load tests, long-running memory profiles): `pnpm load`
  with req/s, p50/p90/p99/max, heap samples after full GC and slope; thresholds
  in the script; report `artifacts/reports/load.json`. Recorded run used the
  advisory latency gate because the shared host was at 100% CPU (starter 23
  req/s, Live actions 15 req/s, p99 ≈ 1.2 s, all advisories); correctness and
  memory gates passed. Gap: no run on a quiet runner; not in nightly CI yet.
- **QA-043** (changesets): fixed group configured; five new patch changesets (uploads+live, views+engine-hbs+engine-ejs, inertia, realtime, observability).
- **QA-046** (semver, deprecations, migration guides):
  `docs/release/versioning-and-deprecation.md`, `docs/release/migration-1.0.md`.
- **QA-055** (edge cases): unicode/RTL/bidi, invalid bytes, lone surrogates,
  noncharacters, prototype keys, deep nesting, accessors in the property suites.
- **QA-056** (property-based testing): done for serialization, protocol
  parsing and path resolution. Gap: idempotent morph invariants (browser
  runtime) not covered.
- **QA-073** (security/chaos corpus): partial (fuzz corpus above). No new
  fault-injection.
- **QA-078/QA-079** (mutation/coverage): mutation testing deferred with
  reasons and a scoped plan in `docs/testing/property-load-mutation.md`. Gap
  remains.
- **QA-082** (regression test per critical bug): every fix has a "regression:"
  test.
- **QA-089/QA-090/QA-091** (nightly, release candidate, release workflow):
  release workflow implements RC checks (matrix, SBOM, audit, artifact
  integrity, load) and owner-approved publishing with OIDC provenance; rollback
  and package ordering documented. Gap: nightly fuzz/load workflow and API diff
  not added.
- **QA-092** (machine-readable reports): `load.json`, `release-plan.json`,
  `release-matrix.json`, SBOM entries in `pack.json`; formats in
  `docs/release/evidence-formats.md`.

### REL

- **REL-016**: threat model and ASVS mapping updated and internally reviewed;
  not independently reviewed (gate remains).
- **REL-017/REL-021**: internal review found no P0/P1; nine lower-severity
  issues fixed. Independent review pending.
- **REL-025**: property evidence present; mutation evidence absent.
- **REL-033/REL-034**: SBOM per tarball; `pack.json` records SBOM file/digest;
  `release-check` verifies them. See test command results below.
- **REL-035**: CI release workflow, Changesets, `release:prepare`,
  `release:check` gates, trusted-publishing setup and ownership verification
  steps, release-notes guidance in `docs/release/release-process.md`.
- REL-001…REL-037 otherwise unchanged.

### MAINT

- **MAINT-010**: governance (roles, ADR/RFC process, review ownership),
  compatibility policy, release cadence and deprecation windows.
- **MAINT-013**: Dependabot for npm and Actions; no auto-merge; NestJS and
  TypeScript majors ignored pending ADR.
- **MAINT-017**: semver/changeset/migration policy documented.
- MAINT-012 (templates) not changed.

### LEDGER

Not modified (coordinator-owned). LEDGER-025 audit tooling unchanged.

## Test commands run (Windows 11, Node 24.13.0, shared host at 100% CPU)

- `pnpm exec vitest run tests/property-*.test.ts` (each suite individually and
  together): all passed (8 files; final counts in the commit history).
- Affected existing suites after fixes: `engine-ejs`, `engine-pug`,
  `engine-nunjucks`, `views`, `custom-engine`, `inertia-security`,
  `inertia-http`, `inertia-protocol`, `live-effects`, `uploads-validation`,
  `realtime`, `realtime-live`, `observability`: passed (331 + 17 + 17 tests).
- `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`,
  `pnpm exec prettier --check` on changed files, `node scripts/docs.mjs`:
  passed.
- `LOAD_SOAK_MINUTES=3 LOAD_LATENCY_GATE=advisory pnpm load`: passed
  (advisories as noted).
- `pnpm release:prepare` (ready: 28 packages → 0.1.0 with current changesets),
  `--target 1.0.0` (blocked as expected), `--target 1.0.0 --write` (ready →
  1.0.0; the generated major changeset was deleted, not committed).
- `pnpm test:pack` (run from PowerShell): passed. 28 tarballs and 28
  CycloneDX SBOMs (159 components in total, each with the tarball hash
  embedded); npm and pnpm full and minimal consumers passed. From Git Bash,
  GNU `tar` on PATH misreads `C:\…` paths as a remote host. That problem
  existed before this branch and is unrelated to it.
- `node scripts/release-check.mjs` after pack: NOT READY, as expected
  (phases, ledger, missing playwright/matrix/security-review evidence,
  advisory load). The new SBOM-verifying pack.json gate passes.
- `pnpm build`: all packages built. `examples/hybrid-dashboard` failed because
  esbuild walked above the worktree to the main checkout's `package.json`, which
  contained merge-conflict markers at the time. This came from the environment,
  not from this branch.
- Final `pnpm test:property`: 8 files, 83 tests passed. Affected existing suites
  (15 files incl. uploads-http, actions-http, forms-hardening, i18n-hbs): 383
  tests passed.

## Notes for the coordinator

- Root `package.json`: new devDependencies `fast-check@4.10.2`,
  `autocannon@8.0.0`; scripts `test:property`, `load`, `release:prepare`;
  eight files appended to `test:security`. Expect conflicts with other
  branches that edit the same script lines.
- `pnpm-lock.yaml` changed (two devDependencies).
- `.changeset/config.json` now has a fixed group and `privatePackages`.
- No Playwright entries were added. Ports used: 3320–3323.
- Do not commit `.changeset/release-major-coordinated.md` until the owner
  decides to cut 1.0 (`pnpm release:prepare --target 1.0.0 --write`).
- `docs/release/evidence/security-review.json` must be supplied by the owner
  from an independent review; the release workflow fails without it.
