# Agent report: showcase and reference examples

Area: ledger groups `SHOWCASE` and `VISION-027..038`, the example list of the
master prompt's repository layout (section 3) and section 27. Branch
`worktree-agent-aa16cc9d76349c701`.

## Examples delivered

Every new example is a runnable Nest application with a README (what it shows,
how to run, root port, security notes, known gaps), uses only published package
entry points, and has at least one Playwright spec with an axe WCAG 2.1 A/AA
check. Specs read their base URL through `tests/browser/example-url.ts`
(`NV_E2E_<NAME>_URL` overrides the root port for local runs).

| Example                        | Root port             | Spec                                                         | Browsers run locally (pass)                                |
| ------------------------------ | --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `examples/starter-ejs`         | 3114                  | `tests/browser/starter-ejs.spec.ts` (6 tests)                | Chromium, Firefox, WebKit 18/18                            |
| `examples/live-crud`           | 3115                  | `tests/browser/live-crud.spec.ts` (7 tests)                  | Chromium, Firefox, WebKit 21/21                            |
| `examples/realtime-dashboard`  | 3116                  | `tests/browser/realtime-dashboard.spec.ts` (6 tests)         | 3 browsers 18/18                                           |
| `examples/upload-to-s3`        | 3117 (+ fake S3 3118) | `tests/browser/upload-to-s3.spec.ts` (5 tests)               | 3 browsers 15/15                                           |
| `examples/multi-tenant`        | 3119                  | `tests/browser/multi-tenant.spec.ts` (7 tests)               | 3 browsers 21/21                                           |
| `examples/express-host`        | 3120                  | `tests/browser/express-host.spec.ts` (shared suite, 6 tests) | 3 browsers                                                 |
| `examples/fastify-host`        | 3121                  | `tests/browser/fastify-host.spec.ts` (shared suite, 6 tests) | 3 browsers (36/36 both hosts)                              |
| `examples/offline-progressive` | 3122                  | `tests/browser/offline-progressive.spec.ts` (7 tests)        | 3 browsers 21/21                                           |
| `examples/integration-matrix`  | 3123                  | `tests/browser/integration-matrix.spec.ts` (14 tests)        | 3 browsers 42/42 (one WebKit load timeout passed on rerun) |

Existing examples reused for section 3 names (mapping documented in the root
`README.md`, no duplicates): `starter-hbs` (+ `starter-live`), `live-counter`,
`auth-forms`, `inertia-react`, `inertia-vue`, `inertia-svelte` (+
`inertia-mixed`), `hybrid-dashboard` (README added). `apps/playground` is not
created as a separate app: `examples/integration-matrix` is the one-server
playground (stated in its README and the root README).

Other changes:

- `tests/support/fake-s3.ts`: backwards-compatible optional `port`, `host` and
  `inspection` options (test-only unauthenticated `GET /__fake/objects`).
  `tests/support/fake-s3-server.ts` runs it as a standalone process for browser
  tests. `tests/uploads-s3.test.ts` still passes (19/19).
- `tests/examples-hosts.test.ts` (added to `test:unit`): enforces that
  express-host and fastify-host share a byte-identical `src/app.ts` and views
  and differ only in `src/main.ts`.
- `tests/browser/host-adapter-suite.ts`: one suite run against both hosts.
- Root `playwright.config.ts`: webServer entries for ports 3114-3123 (not run).
- Root `README.md`: example list and section 3 name mapping.

## Per ledger row

### VISION-027 — one sample server runs the routes concurrently

Implemented: `examples/integration-matrix` (one Express Nest process; `/api/health`
lists the routes). Tests: `tests/browser/integration-matrix.spec.ts`, every route
against the same process. Docs: `examples/integration-matrix/README.md`.
Gap: process-local state (memory broker, sessions, Live store); not a
multi-replica deployment.

### VISION-028 — table header

Covered by the rows below (no behaviour of its own).

### VISION-029 — `/` HBS

`integration-matrix` `/`: layout, application helpers (`price`, `year`) and
block helpers, escaped interpolation (no injected script element),
description/Open Graph/canonical metadata. Test: "VISION-029" in
`integration-matrix.spec.ts`. Also `starter-ejs` (EJS layout/partial/helpers,
escaping, description meta) and `express-host`/`fastify-host`.

### VISION-030 — `/counter` Live/HBS

Actions, server validation of the step input (error alert, `aria-invalid`),
Alpine local state that survives updates and calls `$live.call`, same document
throughout. Test: "VISION-030".

### VISION-031 — `/products` Live/HBS

Debounced URL-bound search, server sort with `aria-sort`, pagination with
no-JS links and `nv:navigate`, validated create form, PNG upload through
`@nestvexa/uploads` with owner-only download (cookieless request refused).
Test: "VISION-031". A fuller CRUD board is `examples/live-crud`.

### VISION-032 / 033 / 034 — `/admin/react`, `/admin/vue`, `/admin/svelte`

Per root: SSR (raw HTML contains the heading and deferred metadata), deferred
`stats` prop, partial reload (`X-Inertia-Partial-Data: extra`), Inertia Link
navigation in one document, form validation errors through the session, flash
after a valid post, 403 without the XSRF header. Tests: "VISION-032/033/034".
Gap: React SSR is in-process here (the separate Inertia SSR server process is
in `inertia-react`).

### VISION-035 — `/hybrid` HBS + islands

React/Vue/Svelte islands as separate lazy chunks, React-to-Vue island event
bridge, an independent Live widget that updates without disturbing island
state, and a `@nestvexa/actions` call (invalid input refused). Test:
"VISION-035". Gap: the action descriptor is hand-written instead of generated
(generation is shown in `actions-basic`).

### VISION-036 — `/realtime` Live + SSE, authorized updates

`integration-matrix` `/realtime`: three browser contexts; a guest post refreshes
two operators over SSE; an operator-only channel reaches the other operator but
never the guest (decoded tokens list only the authorized channels; alert text is
never rendered for guests). Standalone and deeper: `examples/realtime-dashboard`
(metric tiles, operator-only incidents channel, owner-bound job progress,
host-side presence, reconnect after offline). Tests: "VISION-036" and
`realtime-dashboard.spec.ts`.

### VISION-037 — `/api/health` native Nest

Guard, `ParseIntPipe`, interceptor envelope and exception filter run unchanged
(401/400 formatted by the filter). Test: "VISION-037". Also proven on both
platforms by `host-adapter-suite.ts` (express-host, fastify-host).

### VISION-038 — Playwright suite in supported browsers

All specs above ran locally in Chromium, Firefox and WebKit on the agent's port
range. The root suite entries are added but the root config was not run (by
assignment).

### SHOWCASE-001 / 002 / 003 — the showcase application

Implemented as a set of coherent, seeded, non-sensitive domains rather than one
monolith: team task management (`live-crud`), multi-tenant team projects with
host-owned roles (`multi-tenant`), operations dashboard with roles
(`realtime-dashboard`), support desk (`offline-progressive`), files
(`upload-to-s3`), and the all-renderers server (`integration-matrix`). Gap: not
a single application containing all twelve pages; the per-page rows below say
where each page lives.

### SHOWCASE-004 — public HBS landing, SEO, i18n/RTL switch

`integration-matrix` `/` (layout, SEO metadata) and `starter-ejs`. The i18n/RTL
switch exists in the pre-existing `examples/admin-i18n`, not in the new
examples. Gap: no single landing page with all three.

### SHOWCASE-005 — Live CRUD board

`examples/live-crud`: search, sort, pagination, status/priority filters, a
create/edit modal rendered by a nested child component (`aria-modal`, focus
trap, Escape, focus return), confirmation, Zod validation with error summary,
notice region, partial updates via component events, optimistic toggle with
rollback. Tests: `tests/browser/live-crud.spec.ts`. Gap: no file attachments on
tasks (uploads are in `examples/uploads`, `upload-to-s3` and
`integration-matrix` `/products`).

### SHOWCASE-006 — multi-step profile with draft, autosave, validation, no-JS

Partial: `offline-progressive` has local draft autosave, one Zod schema for the
Live action and the no-JS `submitForm` path, and full post/redirect/get without
JavaScript. Gap: no multi-step wizard in these examples.

### SHOWCASE-007 / 008 / 009 — React admin, Vue analytics, Svelte activity

Partial via `integration-matrix` admin roots (SSR, props, errors, forms,
navigation, partial/deferred props per root). Gap: no chart on the Vue page and
no analytics/activity domain.

### SHOWCASE-010 — hybrid dashboard

`integration-matrix` `/hybrid` and the existing `hybrid-dashboard` (README
added): React chart, Vue feed, Svelte widget, Live component. Gap: the Live
widget is not a realtime-driven notification feed.

### SHOWCASE-011 — realtime notifications, job progress, presence, two-instance Redis

`examples/realtime-dashboard`: SSE metric tiles, operator-only channel never
signed into viewer tokens, owner-bound job progress, presence (host code: the
realtime package has no presence primitive; renderless `nv:poll` heartbeat and
expiry sweep). Tests: `realtime-dashboard.spec.ts` (two contexts, presence
join/leave, unauthorized channel negatives, forged viewer action 403, reused
operator token 403, job completion, offline/online recovery, axe). Gap: no
two-instance Redis browser test (needs Docker); cross-replica coverage remains
the RESP test double in `tests/realtime.test.ts`.

### SHOWCASE-012 — secure upload flow, local and optional S3

`examples/upload-to-s3`: `S3Storage` from env only (fails fast naming missing
variables), direct browser PUT to a presigned URL (no chunk traffic to the
server), finalize re-reads the stored object (a PDF declared as PNG is refused
and deleted), owner-only streamed download and 60 s presigned GET, CSRF/origin
checked delete, a no-JS multipart path, CSP `connect-src` limited to self and
the bucket origin. Tests: `upload-to-s3.spec.ts` against the fake S3 test
double, including cross-session 404/403, cross-origin delete 403, oversized,
HTML and mislabelled files. Local storage: existing `examples/uploads`. Gap:
not run against AWS S3 or MinIO; no virus scanner configured.

### SHOWCASE-013 — native REST endpoint (optional GraphQL)

`integration-matrix` `/api/health`, `/secure`, `/square/:value`;
`express-host`/`fastify-host` `/api/notes` (guard, pipe, interceptor, filter on
both platforms); `live-crud` `/api/tasks`. Gap: no GraphQL operation (optional).

### SHOWCASE-014 — guest/member/admin roles, two tenants, no cross-account leaks

`examples/multi-tenant`: two seeded tenants, five demo accounts (scrypt), one
member of both tenants, session regeneration and CSRF rotation on sign-in and
sign-out, `TenantGuard` on pages and `GET /api/t/:tenant/projects`, Live
binding `user:<id>:tenant:<slug>:role:<role>:session:<sid>`, tenant always from
the session. Negative tests in `multi-tenant.spec.ts`: cross-tenant page/API
403 with no foreign data in the body; another account's snapshot replayed with
the attacker's cookie and CSRF gets 410 `INVALID_SNAPSHOT`; same after a tenant
switch; member forging admin-only `remove` gets 403 `ACTION_FORBIDDEN`; wrong
CSRF 403; guest redirected / API 401. Also per-guest isolation and snapshot
replay rejection in `host-adapter-suite.ts` and `live-crud.spec.ts`.

### SHOWCASE-015 — empty/loading/error/offline states, keyboard, focus, screen readers

Partial, across examples: `offline-progressive` (`nv:offline`, interrupted
submit status, labelled read-only snapshot, error summary, noscript, axe with
and without errors); `live-crud` (empty list state, loading-disabled submit,
modal focus management and Tab trap, Escape, focus return, `role="status"`
notices); every new spec has axe scans. Gap: no single consistent pass over all
twelve showcase pages.

### SHOWCASE-016 — seed/reset scripts, Docker Compose, no paid services

Partial: every example seeds in-memory data per session/process (restart
resets); the S3-compatible test double runs as a standalone process for the
browser suite; no paid service is required. Gap: no Docker Compose for
Redis/MinIO and no separate seed/reset scripts.

## Framework findings (not fixed here; for the owning areas)

1. Live client: a failed refresh while offline (realtime invalidation arriving
   under `setOffline`) suspends the component until reload
   (`packages/client/src/index.ts` `suspend()`); likewise a network-failed
   submit needs a reload before submitting again. `docs/guides/offline.md`
   step 5 implies you can submit again without reloading; the
   `offline-progressive` README describes the actual behaviour.
2. Live client: every rendered response re-signs the realtime token with a new
   expiry, so the client reopens the event stream; events published in that gap
   are not replayed.
3. Live: changing a parent-owned `@Reactive` prop inside a child action returns
   409 `REACTIVE_PROP_MUTATED` after the action's side effects ran.
4. Live client: for a form inside a nested child component (live-crud's editor),
   the documented "focus the first invalid field after submit" did not happen
   (focus ended on `<body>`); live-crud's host script compensates. The
   top-level case is covered by `tests/browser/forms.spec.ts`.

## Coordinator notes

- Root `playwright.config.ts` now has entries for 3114-3123 (fake S3 on 3118).
  The realtime-dashboard entry needs `DASHBOARD_TICK_MS=0` and
  `PRESENCE_TTL_MS=6000`; upload-to-s3 needs its `S3_*` env pointing at 3118.
- `tests/examples-hosts.test.ts` was added to `test:unit` in `package.json`.
- `pnpm build` now also builds nine more examples; integration-matrix alone
  runs three type checks, six Vite builds and an esbuild islands bundle
  (about a minute).
- `docs/feature-matrix.md` does not exist in this branch; the example mapping
  lives in the root README.
