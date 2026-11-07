# Agent report: security tests and policy, round 4

Branch: `worktree-agent-a5a2bc8a3e7823f9c` (from `main` at `acf4168`). Date:
2026-11-07. Ledger rows: SEC-007, SEC-008, SEC-016, SEC-017, SEC-022, SEC-029,
SEC-030, plus the internal design review and ASVS mapping refresh. No
ledger, progress, STATUS or final report file was edited. Nothing was pushed,
merged, versioned or published.

All reviews in this round are **internal**. No independent or third-party
review happened; only the owner can supply one.

## Vulnerabilities found and fixed

| ID     | Package | Severity | Finding                                                                                                                                                                                                                                                     | Regression test                 |
| ------ | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| SR4-01 | inertia | P2       | Cache poisoning: JSON page responses sent `Vary: X-Inertia` only, though partial-reload, reset, error-bag, merge-intent, except-once and version headers select their content. A shared cache could replay one partial reload to every later Inertia visit. | `tests/cache-poisoning.test.ts` |
| SR4-02 | cache   | P2       | Private-key collision: UTF-8 hashing maps every unpaired surrogate to U+FFFD, so distinct malformed identity bindings shared one private cache key.                                                                                                         | `tests/cache-poisoning.test.ts` |
| SR4-03 | inertia | P3       | `HttpSsrGateway` buffered the whole `/render` body before its size check; `/health` read unbounded bodies and followed redirects.                                                                                                                           | `tests/ssrf.test.ts`            |
| SR4-04 | inertia | P3       | The SSR gateway URL accepted embedded credentials, a query or a fragment.                                                                                                                                                                                   | `tests/ssrf.test.ts`            |

Changesets: `.changeset/security-round4-inertia.md`,
`.changeset/security-round4-cache.md` (patch).

## By ledger row

### SEC-007: partial and deferred props are re-authorized

- Implemented: test only; the adapter already re-runs guards and handlers per
  request. `tests/inertia-reauthorization.test.ts` (Express and Fastify, 12
  tests): the guard runs again for every partial reload and denies a revoked
  identity; props a handler withheld are never resolved whatever the partial
  headers request; deferred and optional factories re-check policy at
  resolution time; a rescued deferred prop whose policy fails is omitted;
  resource ownership is re-checked on partial reloads of another identity's
  resource; interleaved partial reloads resolve with each request's own
  identity.
- Docs: design review row "Inertia".
- Gap: none for the adapter. Prop factories must re-check their own policy
  (documented host responsibility).

### SEC-008: CORS posture

- Implemented: test and documentation. No package sets CORS headers (verified
  by grep and test).
- Test: `tests/cors-posture.test.ts` (Express and Fastify, 6 tests). Preflights
  from hostile, `null` and look-alike origins to Live, action and both upload
  routes get no CORS headers. Credentialed cross-origin writes with valid CSRF
  tokens (six origin variants, including none) get 403 before any handler or
  policy runs (side-effect counters), with same-origin controls succeeding.
  With host-enabled reflected credentialed CORS, writes are still refused.
- Docs: `docs/security/cors.md` (new), linked from `hardening.md` and the
  security guide.
- Gap: Live model-sync and realtime routes are not in the preflight list
  (realtime WebSocket origin checks have their own tests).

### SEC-016: supply chain

- `pnpm audit:licenses` (`scripts/licenses.mjs`): SPDX allowlist over the
  production closure of every public package (`pnpm licenses list --prod`) plus
  each declared peer; fails on copyleft, missing or unknown licenses unless an
  exact `name@version` is reviewed in the script (none needed). Local run: 163
  packages (MIT 148, ISC 5, Apache-2.0 4, BSD-3-Clause 3, BSD-2-Clause 2, 0BSD
  1), no failures.
- `pnpm secrets:scan` (`scripts/secrets.mjs`): dependency-free scan of tracked
  and unignored files for 11 high-confidence credential formats and committed
  `.env` files, with an explicit allow marker. Local run: 1,601 files, no
  findings (one fake Redis password in `tests/cli-fastify.test.ts` now carries
  the marker).
- CI: new `supply-chain` job in `.github/workflows/ci.yml` runs both scripts
  and `trufflesecurity/trufflehog@ea68ca03c865c5f324e86e849ced20ed3cf9dbbb`
  (the commit of tag v3.99.8, checked with `git ls-remote`) over the full
  history; `.github/workflows/security.yml` also runs the license audit weekly.
- `SECURITY.md`: new "Supply chain" section. Provenance is described as
  configured in `release.yml` but never exercised; no published package carries
  a verified attestation.
- Tests: `tests/supply-chain-scripts.test.ts` (29 tests: SPDX expression
  classification, every secret rule positive and negative, placeholders,
  allow markers).
- Gap: the TruffleHog job has not run on GitHub yet (it runs on the next push).

### SEC-017: telemetry collection and retention

- Docs: `docs/security/telemetry.md` (new): every opt-in hook (server spans,
  request spans, trace context, OpenTelemetry bridge, logger, devtools, render
  budgets, browser timing samples), exactly what each emits, that nothing is
  transmitted by default, and the in-memory retention bounds (500 spans, 100
  inspector renders). `hardening.md` no longer says the packages include no
  telemetry.
- Evidence: existing observability suites; `tests/ssrf.test.ts` pins the
  outbound network inventory (no telemetry endpoint).
- Gap: none in the framework; host export and retention are host-owned.

### SEC-022: Alpine injection and hostile Vue/Svelte props

- `tests/browser/alpine-injection.spec.ts` (examples/live-counter, CSP Alpine
  under `script-src 'self'`): nine payloads (attribute breakouts with `x-init`,
  `<div x-data x-init>`, `<template x-if>`, `@click`, `nv:click` markup, bare
  directives, `$live.call(...)`, Handlebars syntax) are saved through Live,
  rendered by Handlebars into text, attribute and input values and morphed.
  The directive inventory of the document never changes, the server count stays
  0 (an injected `$live.call('increment')` would raise it), no CSP violation
  fires, and Alpine is proven live afterwards.
- `tests/browser/inertia-hostile-props.ts` (wired into `inertia-vue.spec.ts`
  and `inertia-svelte.spec.ts`): a test-only page `/__test/hostile`
  (`--test-controls`) in both examples serves script, event-handler,
  attribute-breakout, quote, comment, Vue/Svelte template syntax, template
  literal and U+2028/9 payloads plus `javascript:`, mixed-case, tab,
  leading-whitespace, `data:` and `vbscript:` links. Four tests per framework:
  raw SSR HTML and Inertia JSON (exact round-trip, no script-closing sequence,
  no payload tags, no unfiltered URLs, inert without JavaScript), hydration,
  client-only mount, and an Inertia visit. Each checks exact text and attribute
  values, no injected handler, element or script, no `window.__nvXss`, no CSP
  violation and no page error.
- Finding (documented, not a Nestvexa defect): Vue and Svelte do not filter URL
  schemes. The examples use `client/safe-href.ts`; the security guide and the
  design review tell hosts to allowlist schemes. React blocks `javascript:`
  URLs itself.
- Docs: `docs/security/guide.md` (Alpine expression attributes, URL schemes),
  example READMEs.
- Gap: React hostile-props browser test not added (not in scope); no framework
  `safeHref` helper is shipped.

### SEC-029: SSRF

- `tests/ssrf.test.ts`: the SSR gateway refuses non-http(s), credential, query
  and fragment URLs; always posts to the configured `/render` whatever the
  page contains; never follows redirects from `/render` or `/health`; stops
  reading oversized or endless responses. S3 storage keeps every object,
  presigned and download URL on the configured host and does not follow
  redirects. A static inventory of outbound primitives in all package sources
  must match the reviewed list exactly.
- Fixes: SR4-03, SR4-04.
- Gap: mail has no network transport, so none was tested; ClamAV and Redis
  targets are inventoried, not exercised against real services.

### SEC-030: cache poisoning and coalescing

- `tests/cache-poisoning.test.ts`: unkeyed forwarding and override headers do
  not change Inertia documents, JSON or 409s, nor immutable assets (Express and
  Fastify) or the Vite static middleware; JSON page responses list every
  content-selecting header in `Vary`; a keyed shared-cache model never serves a
  cached partial reload to a full visit. `@nestvexa/cache` single-flight
  computes once per identity under concurrency, separates tenants and
  public/private, isolates failures, gives every caller a private copy, refuses
  stale-while-revalidate for private entries and refuses malformed bindings.
- Fixes: SR4-01, SR4-02. The golden fixture
  `tests/fixtures/inertia/02-inertia-json-response.json` now checks the upstream
  `Vary` value as a prefix.

### Design review and ASVS mapping

- `docs/security/security-design-review.md` rewritten for the current code
  (dated 2026-11-07), labelled INTERNAL, with design controls by boundary,
  this round's findings and the remaining release blockers.
- `docs/security/asvs-traceability.md`: labelled internal; 15 new rows checked
  against the tagged v5.0.0 chapters (1.2.1, 1.2.2, 1.2.3, 1.3.2, 1.3.6, 3.4.2,
  3.5.1, 8.3.1, 13.3.1, 14.2.2, 14.2.3, 14.2.5, 15.1.2, 15.3.2, 16.1.1).

## Verification

The host was heavily loaded (about 97% CPU from parallel agents), so runs
were targeted.

- `pnpm --filter @nestvexa/inertia --filter @nestvexa/cache build`: pass.
- `pnpm exec vitest run` on `tests/cache-poisoning.test.ts`,
  `cors-posture`, `inertia-reauthorization`, `ssrf`, `supply-chain-scripts`,
  `inertia-precognition`, `inertia-golden`, `cache`, `inertia-http` and
  `inertia-security`: 10 files and 263 tests passed. `tests/ssrf.test.ts` was
  rerun after the type fix: 28 passed.
- `pnpm audit:licenses`: 163 packages, no failures. `pnpm secrets:scan`:
  1,601 files, no findings.
- `pnpm lint` (eslint and boundaries): pass.
  `pnpm exec tsc -p tsconfig.tests.json --noEmit`: 0 errors (after commit
  "read UploadError status through getStatus()"; an earlier run had hidden
  this error behind a pipe).
- `pnpm docs:build`: 231 documents checked, pass. Prettier `--check` on every
  changed and new file: pass. I did not run the repo-wide `pnpm format:check`.
- Example builds (`pnpm --filter @nestvexa/example-inertia-vue build`, and the
  same for Svelte, including vue-tsc and svelte-check with 0 errors): pass.
- Playwright (uncommitted `playwright.local.config.ts`, ports 3900–3904,
  `-g "hostile|Alpine or Live directive"`):
  - chromium: 9 of 9 passed.
  - First Firefox and WebKit run: 11 passed and 7 failed. On Firefox, the
    failures were page or context timeouts alongside Firefox GFX compositor
    crash messages from the loaded host. On WebKit, the alpine spec hit the
    default 30 s test timeout across nine round trips, and an 11-item pointer
    hover timed out. Fixes: the alpine spec now has a 120 s test timeout, and
    the hostile-props suite dispatches `mouseover` and `focus` events instead
    of pointer hovers.
  - Rerun after those fixes: chromium 9 of 9 passed again. Firefox failed its
    first three tests the same way: "Test timeout exceeded while setting up
    page", meaning the browser could not open a page on the loaded host. I
    stopped the run before WebKit started. **Not verified:** the two WebKit
    fixes (the alpine timeout and the Vue Inertia-visit hover), and every
    Firefox test except the four that passed in the first run (the Vue and
    Svelte server-HTML tests, the Vue client-only mount and the Vue Inertia
    visit). The coordinator should run these specs on Firefox and WebKit on
    an idle host or in CI.
- `pnpm size:check` was not run, because no client package code changed.

Also fixed on `main` during this round (not on this branch): a truncated
multipart body made busboy emit `error` twice in `@nestvexa/uploads`
(`packages/uploads/src/service.ts`), and the uncaught second emission crashed
the process (single-request DoS). It is recorded in the design review.

## Notes for the coordinator

- `package.json`: new scripts `audit:licenses` and `secrets:scan`;
  `test:security` gains `tests/inertia-reauthorization.test.ts`,
  `tests/cors-posture.test.ts`, `tests/ssrf.test.ts`,
  `tests/cache-poisoning.test.ts` and `tests/supply-chain-scripts.test.ts`.
  Expect a textual conflict on that line if other branches append to it.
- Root `playwright.config.ts`: no change needed. The new specs reuse servers
  already in the root config (live-counter 3101, Vue 3107/3211, Svelte
  3108/3212). The examples must be rebuilt for `/__test/hostile`.
- `.github/workflows/ci.yml`: new `supply-chain` job; `security.yml` gains a
  license-audit step.
- The Inertia `Vary` change alters a response header other branches may assert
  exactly (`tests/inertia-precognition.test.ts` was updated here to a prefix).
