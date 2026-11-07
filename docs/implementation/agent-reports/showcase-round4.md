# Agent report: showcase, round 4 (coherent showcase app)

Area: ledger group `SHOWCASE` (master prompt section 27). Branch
`worktree-agent-a0b59de13ad4ffc95`. Round 1 (`showcase.md`) delivered nine
single-feature examples; this round adds `examples/showcase`, one Nest
application that combines them for one product.

Note on ids: the assignment named SHOWCASE-014 for "Redis two-instance
coverage" and SHOWCASE-015/016 for "Compose and seed/reset". In the ledger,
the two-instance Redis test is part of SHOWCASE-011, SHOWCASE-014 is roles
and tenants, SHOWCASE-015 is graceful states, and SHOWCASE-016 is
seed/reset/Compose. This report uses the ledger ids.

## What was built

`examples/showcase` (package `@nestvexa/example-showcase`, root port 3124):

- Two fictional workspaces (Harbor Studio, Summit Labs), each with an admin
  and a member, seeded with non-sensitive data (`src/seed.ts`).
- Host-owned auth (`src/identity.ts`): scrypt password check with a dummy
  derivation for unknown emails, session regeneration on sign-in, a CSRF
  token per session, one identity binding (account, workspace, role,
  session) shared by Live, realtime and uploads, a channel policy, a Live
  action allowlist with an admin-only action, and a native Nest guard with
  `@Roles` for pages, REST and Inertia routes.
- Pages: public HBS landing (`/`), sign-in, the dashboard (`/app`: Live
  realtime metrics over SSE, per-instance presence, inbox, offline notice,
  and an SSR Vue island chart), the Live task board (`/app/tasks`), the
  profile wizard (`/app/profile`), the mail outbox (`/app/outbox`), the Vue
  Inertia section (`/insights`, `/insights/goals`) with SSR, and native REST
  (`/api/health`, `/api/tasks`, `/api/tasks/:id`).
- Mail through `@nestvexa/mail` (EXT-029): `MailModule` with HBS templates
  and layout, `NotificationBridge` with mail, inbox and realtime channels
  (`src/notify.ts`); memory (test) transport by default, console transport
  with `MAIL_TRANSPORT=console`.
- Optional Redis (`REDIS_PORT`): `RedisRealtimeBroker` plus Redis-backed
  metrics and inboxes (`src/metrics.ts`). Optional S3-compatible storage
  (`S3_*`); a partial S3 configuration fails at startup (`src/config.ts`).
- `pnpm seed` / `pnpm reset` (`src/scripts/`), `Dockerfile`,
  `docker-compose.yml` (app, `redis:7-alpine`, `chrislusf/seaweedfs`).
- README: what it is and is not, pages, configuration, seed/reset, two
  instances, Compose, what each test proves, known gaps.

Fixes made while finishing this round (found by the browser tests):

- Upload purposes were `task.attachment` / `profile.avatar`, but the browser
  client requests `<component>.<field>` (`task-editor.attachment`,
  `profile-wizard.avatar`), so every browser upload failed with
  `404 UNKNOWN_PURPOSE`. Renamed the purposes.
- `/insights` answered guests with a JSON 401 instead of the sign-in
  redirect every other page uses. `InsightsController` now uses the same
  `PageAccessFilter`.
- Test corrections: wait for "Uploaded 1 file" (the status reads
  "Uploading n%" first), re-mark the document after a deliberate reload,
  drop a wait for an SSE reconnect the client does not make, and no axe
  check in the JavaScript-disabled context (axe is page script).

## Per ledger row

### SHOWCASE-002: coherent showcase application

Implemented: `examples/showcase` (above). Tests:
`tests/browser/showcase.spec.ts` (12 tests, axe WCAG 2.1 A/AA on every
visited page with JavaScript), `tests/services/showcase-redis.spec.ts` (4
tests, real Redis). Docs: `examples/showcase/README.md`, root `README.md`
example list. Gap: React/Svelte Inertia pages and React/Svelte islands are
not in this app (they are in `examples/inertia-*` and
`examples/hybrid-dashboard`).

### SHOWCASE-004: public landing

Implemented: HBS landing with layout, description, canonical and Open Graph
metadata, the workspace list. Test: "the public landing page is search
friendly ...". Gap: no i18n/RTL switch in the showcase (covered by
`examples/admin-i18n`, not here); no separate catalog page.

### SHOWCASE-005: Live CRUD board

Implemented in the showcase: URL-bound search, status/priority filters,
sorting with `aria-pressed`, pagination with no-JS links and `nv:navigate`,
a nested editor component in a modal dialog (focus moved in, Tab cycle,
Escape, focus returned), server validation with an error summary, file
attachments through `@nestvexa/uploads` (workspace-only download), toast
notice, optimistic `done` toggle, admin-only delete behind `nv:confirm`.
Tests: "an admin creates a task with an attachment ...", "the task board
searches, filters, sorts and pages ...", "an admin pages through the board,
completes a task optimistically and deletes it only after confirming" (the
toggle request is held by the test, and the projected value is asserted
before the server answers), and the forged-delete negative test.

### SHOWCASE-006: multi-step profile setup

Implemented: `ProfileWizard` Live component on `@nestvexa/forms`'
`defineWizard`: per-step zod validation on the server, Back/Continue that
keep values, consented autosave of drafts through `createDraftManager`
(version-checked; restored after reload; discarded on save; switching it off
deletes the draft), avatar upload, `finish` re-validates every step,
confirmation email. No-JS fallback: `POST /app/profile` with the same wizard
definition, progress in the session, read-once errors and old input,
origin and CSRF checks. Tests: "the profile wizard validates each step,
autosaves a consented draft and sends a confirmation email" and "the
profile wizard works without JavaScript through ordinary form posts"
(includes a cross-site POST refused with 403). Gap: drafts are in process
memory (`MemoryDraftStore`), so they do not survive a restart or cross
instances.

### SHOWCASE-008: Vue Inertia analytics page with partial/deferred props and a chart

Implemented: `/insights` (`Analytics.vue`) with Vue SSR (`moduleSsrRenderer`,
fallback mode), a deferred `throughput` prop rendered as a bar chart with a
data table, an optional `breakdown` prop loaded by a partial reload, and
`/insights/goals` (`Goals.vue`) with validation errors, flash, admin-only
create (native guard) and host XSRF. Test: "the Vue Inertia analytics
section renders on the server, defers the chart and reloads partially"
(server HTML before JavaScript, `deferredProps`, `X-Inertia-Partial-Data:
breakdown`, same-document navigation, errors, flash) and the role/XSRF part
of the roles test.

### SHOWCASE-010 (partial): hybrid dashboard

Implemented: the HBS dashboard holds a Live notification/metrics component
next to an independent Vue island; a Live update does not reset the
island's selected range (asserted). Gap: no React chart or Svelte widget in
this app (`examples/hybrid-dashboard` has all three frameworks).

### SHOWCASE-011: authorized realtime notifications and presence, two-instance Redis

Implemented: workspace metrics channel and per-user notification channel,
authorized at signing, connect and delivery; per-instance presence; task
assignment and profile completion notify through mail, inbox and realtime.
Tests (single process): realtime refresh for the same workspace only; the
token names exactly `metrics:<workspace>` and `notify:<user>`; a replayed
token is 403 for another account; a guest is refused; assignment reaches
the assignee's inbox without a reload. Two instances with real Redis
(`tests/services/showcase-redis.spec.ts`, run locally against Docker
`redis:7-alpine` on host port 6396 with instances on 3941/3942): both report
the Redis broker; a deployment logged on B refreshes a dashboard on A and
not another workspace's dashboard on A; presence stays per instance; a task
assigned on A reaches the assignee's inbox on B and nobody else's; a token
signed on A is refused on B for another account. Gap: no job-progress
feature in the showcase (covered by `examples/realtime-dashboard`); presence
is per instance by design of `@nestvexa/realtime`.

### SHOWCASE-012: secure uploads, local and optional S3

Implemented: two purposes with type, size and count limits, signed-in
workspace members only, finalize re-checks identity/purpose/size/hash/type,
files stored under the data directory (never served statically), downloads
through workspace-scoped routes (404 for other workspaces), owner-only
avatar. S3: `S3_*` switches to `S3Storage`. Tests: attachment upload and
download, cross-workspace 404, avatar owner download. Gap: the showcase's
S3 path is not exercised by a test here (S3Storage itself is covered by
`tests/uploads-s3.test.ts` and `pnpm test:services`).

### SHOWCASE-013: native Nest REST

Implemented: `ApiController` with native guards; workspace-scoped list and
item, 404 for another workspace's id. Tests: guest 401, health, list scoping
and cross-workspace 404 in the task test. Gap: no GraphQL operation.

### SHOWCASE-014: roles, two tenants, no cross-account leaks

Implemented: guest/member/admin with two workspaces; host-side role checks.
Tests: guests redirected from every members-only page and 401 from REST; a
member's forged admin-only Live action is 403 `ACTION_FORBIDDEN`; another
account replaying a snapshot is 410 `INVALID_SNAPSHOT`; a wrong CSRF token
is 403; member Inertia goal create is 403; missing XSRF is 403; the other
workspace cannot list, fetch or download a task, nor see its mail; realtime
does not cross workspaces.

### SHOWCASE-015: graceful states, keyboard, focus, screen readers

Implemented: empty board state, error summaries with links and
`aria-invalid`, `role="status"` notices, an offline notice (`nv:offline`),
dialog focus management (`public/dialog.js`), focus return, `aria-current`
on steps and pages. Tests: empty state, dialog keyboard handling, offline
announcement and recovery, axe on every page. Gap: no explicit
network-failure test (server down mid-action) for the showcase; loading
states are not asserted.

### SHOWCASE-016: seed/reset and Docker Compose

Implemented: `pnpm seed` (refuses to overwrite without `--force`),
`pnpm reset` (data file, local uploads, Redis keys under `REDIS_PREFIX` via
`SCAN`/`DEL`; S3 objects deliberately kept), `Dockerfile` (non-root,
healthcheck) and `docker-compose.yml` (loopback-only ports, the images of
`.github/workflows/services.yml` and `docs/guides/production-services.md`).
Validation: `docker compose -f examples/showcase/docker-compose.yml config`
passes. Gap: the Compose stack was not brought up (the assignment allowed
`config` only); the seed/reset scripts have no automated test. No
screenshots were produced.

## Root configuration

- `playwright.config.ts`: webServer entry for the showcase on 3124 with a
  fresh `SHOWCASE_DATA_DIR` per run (not run).
- `playwright.services.config.ts`: two showcase instances on 3223 and 3224
  for `tests/services/showcase-redis.spec.ts` (not run with that config;
  the same spec was run locally against my own ports).

## Verification (local, Windows host under heavy shared load)

- `pnpm --filter @nestvexa/example-showcase... build`: passes (tsc,
  vue-tsc, Vite client and SSR builds).
- `pnpm exec eslint examples/showcase tests/browser/showcase.spec.ts
  tests/services/showcase-redis.spec.ts playwright.config.ts
  playwright.services.config.ts` and `node scripts/boundaries.mjs`: pass.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: no errors in the files of
  this round. The only errors reported come from test files that import
  packages not built in this worktree (`react`, `svelte`, `ui`,
  `engine-ejs`, `engine-pug`, `engine-nunjucks`).
- `prettier --check` on every changed file: passes.
- `docker compose -f examples/showcase/docker-compose.yml config`: passes.
- `tests/browser/showcase.spec.ts` against one instance on port 3940:
  Chromium 12/12. Firefox 11/12: the dashboard test (three accounts, three
  realtime dashboards) timed out at 180 s while still creating browser
  contexts, in two runs; every assertion it reached passed. WebKit: not
  verified. The first three tests each hit the 180 s timeout while the host
  was saturated (a plain curl to the server took over two minutes), and the
  run was stopped. The WebKit run, and the Firefox dashboard test, should be
  repeated on an idle host or in CI.
- The Redis spec ran in Chromium only.
- `tests/services/showcase-redis.spec.ts` against two instances on ports
  3941/3942 and Docker `redis:7-alpine` (`nv-r4-redis`, host port 6396):
  Chromium 4/4. A first attempt failed while Docker Desktop's engine stopped
  answering (the instances logged `Redis connection closed`); the rerun
  after it recovered passed.
