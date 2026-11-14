# Agent report: showcase, round 5 (remaining gaps)

Area: ledger group `SHOWCASE` (master prompt section 27), app
`examples/showcase`. Branch `r5-showcase-remainder`, based on main `c9ac364`.
This round closes the gaps that round 4 (`showcase-round4.md`) left in
SHOWCASE-004, -010, -015 and -016, and records the decision on SHOWCASE-002.

Note on the environment: the OS temp cleaner deleted this worktree once in
the middle of the round, and every uncommitted change was lost. The work was
redone from the conversation record, and WIP checkpoints were committed after
that. The final history squashes them into the commits listed at the end.

## SHOWCASE-004: public landing with an i18n/RTL switch

Implemented with `@nestvexa/i18n` (new dependency of the example only):

- `src/i18n.ts`: `I18n` with `en` and `ar` (`dir: 'rtl'`), catalogs
  `locales/<locale>/{common,islands,insights}.json` loaded with
  `loadCatalogs`, the time zone fixed to UTC. Negotiation goes `?lang=`, then
  the `nv-locale` cookie, then `Accept-Language`, then English, allowlisted
  values only. Locales are presentation only (never in a binding, channel or
  snapshot).
- `POST /locale` (`src/pages.ts`): a native form on every HBS page and in the
  Vue Inertia layout. Session CSRF required (403 otherwise), `match()`
  allowlist (400 for anything else, including CR/LF injection), cookie from
  `localeCookie()` (Secure on HTTPS origins), return path allowlisted
  (`safeReturn`, no open redirect).
- HBS: the layout prints `lang`/`dir` through the i18n helpers (registered
  before `configureNestvexa`); the landing page has `hreflang` alternates per
  language; layout, landing, sign-in (including its error), dashboard, metrics
  panel and the new 500 page are translated. `public/app.css` uses logical
  properties (the skip link was the only physical one), so the header and
  cards mirror.
- Live: `MetricsPanel` has `@Computed() i18n` and a translated notice (the
  state stores a message key), so Live actions and realtime `$sync` refreshes
  render in the language the browser asks for at that moment.
- Inertia: a custom root view prints `lang`/`dir` (server-rendered RTL before
  any script), the shared props carry `i18n.hydration(...)` (an explicit
  message subset) and the Vue pages translate with `useTranslate()`
  (`client/inertia/i18n.ts`, `@nestvexa/i18n/client`) during SSR and in the
  browser. The analytics heading is translated on the server.
- Fix found by the regression run: the global `dir` helper shadowed the task
  board's `dir` (sort direction) field; the view now reads `{{this.dir}}`.

Tests: `tests/browser/showcase-locale.spec.ts` (4 tests): switch and back
with axe in both directions and a mirrored header check (brand to the right of
the nav in RTL), cookie carried to `/login`; negative tests for the switch
(unknown locale, injection, wrong CSRF, off-site return, unlisted `?lang=`);
Arabic kept across a Live action, a realtime refresh triggered by an
English-speaking teammate (same document) and island interaction (Arabic
plural formatted in the browser by the Svelte widget); Inertia pages
server-rendered RTL, an Inertia visit keeping the document and direction, and
the Vue layout's switch back to English.

Remaining gap: the task board, profile wizard, outbox and goals form are not
translated (marked `lang="en"`); stored event texts (inbox, "latest") stay in
the language they were written in. There is still no separate catalog page.

## SHOWCASE-010: hybrid dashboard with React chart, Vue island, Svelte widget

Implemented with `@nestvexa/islands` and the `@nestvexa/ui` React chart
wrapper:

- `client/islands/member-chart.tsx` (React): open/done tasks per member drawn
  by `Chart` from `@nestvexa/ui/react` (SVG with classes, data table, no
  `style` attribute); local chart-type state (bars/lines); "Focus on …"
  buttons emit `member.focus` on the islands event bridge. Strategy
  `interaction` (the server-rendered chart is complete; React loads on hover,
  focus, pointer or key).
- `client/islands/PulseWidget.svelte` (Svelte 5, no `<style>` block): progress
  of done tasks, a counts/percentage toggle, and the focused member received
  through `island.on(..., accept)` with a validating `accept`; the sentence is
  formatted with `@nestvexa/i18n/client` from a `hydrationScript()` subset.
  Strategy `idle`.
- `client/islands/throughput-chart.ts` (Vue, existing): now takes translated
  captions and labels. Strategy `visible`.
- `src/islands.ts`: closed props schemas for all three, `dashboardIslands()`
  renders them with `renderSsr` in the request's locale and returns the
  `contextScript` (locale, direction) and the i18n hydration script.
- Build: `vite.config.ts` adds `@vitejs/plugin-react` 6.1.2 and
  `@sveltejs/vite-plugin-svelte` 7.3.1 (versions already in the lockfile);
  each island is a lazy chunk of the one islands loader; `client/ssr.ts` adds
  `reactIslandRenderer` and `svelteIslandRenderer`. `/assets/ui.css` serves
  the `@nestvexa/ui` theme (light palette pinned in `app.css`).
- CSP: unchanged strict policy (`script-src 'self'; style-src 'self'`, no
  `'unsafe-inline'`).

Tests: `tests/browser/showcase-islands.spec.ts` (2 tests): the CSP header,
SSR output of all three islands in the raw HTML (not the fallback), no inline
`style` attributes or inline scripts, inert JSON scripts; Svelte hydrates
when idle, Vue when visible, React's chunk is not requested before hover and
hydrates after; no hydration mismatch markers; local state in each island;
React to Svelte event with a forged invalid event dropped; a Live update
leaves all island state alone; axe; no `securitypolicyviolation` event. The
existing dashboard test still checks the Vue island across Live updates.

Remaining gap: on touch screens the first tap on the React chart may only
load it (the `interaction` strategy does not replay the event).

## SHOWCASE-015: graceful empty/loading/error/offline/network-failure states

Implemented:

- 500 page: `ErrorPageFilter` (`src/pages.ts`) on the page controllers
  renders `views/error.hbs` (translated, CSP, `no-store`) with an 8-character
  reference that matches the server log line; no error text or stack is
  sent. 401/403 keep the existing redirect/forbidden page; HTTP exceptions
  and non-document requests keep Nest's JSON bodies (a first version as a
  global catch-all filter broke Inertia validation errors; found by the
  regression run and replaced by controller-scoped filters).
  `SHOWCASE_TEST_FAULTS=1` adds `GET /__faults/error` (`src/faults.ts`);
  refused with `NODE_ENV=production`.
- Loading: `#metrics-saving` (`role="status"`, `nv:loading`) and the disabled
  button while `logDeployment` is in flight.
- Offline/server down: `public/connection.js` (served from `/assets`, CSP
  `'self'`) listens for `nestvexa:error` with `NETWORK`/`TIMEOUT` and the
  `offline` event, shows a `role="status"` banner, probes `/api/health` with
  a capped backoff, then reports the connection back and, when the Live
  client suspended a component (`data-nv-suspended`), offers a reload. It
  never resends a request. Suspended components get an outline (a first
  version dimmed them with opacity and failed axe contrast).
- `SESSION_STORE=file` (`src/session-store.ts`): an `express-session` store in
  the data directory so a restart of one process keeps users signed in.
  Dashboard metrics without Redis are now persisted with the showcase data
  (`metrics` in `showcase.json`), so they survive a restart too.

Tests: `tests/browser/showcase-resilience.spec.ts` (3 tests, its own server
process on `NV_SHOWCASE_RESILIENCE_PORT` + worker index, or an OS-assigned
port): 500 page in English and Arabic with axe, and a JSON 500 for a non-page
request; slow network (the Live request is held by the test): "Saving…",
disabled button, `aria-busy="true"`, all cleared; server killed mid-session
(`SIGKILL`): the next click shows the offline notice, the banner and a
suspended component; after the restart the banner reports recovery and
offers a reload, the page sends no Live request by itself, and after the
reload the user is still signed in, the deployment count is unchanged (no
replay) and one more click adds exactly one.

Remaining gap: Live component state is in process memory, so pages open
across a restart must reload (the banner offers it); the banner learns about
an outage from a failed Live request or the `offline` event, not from the
realtime stream (the client does not expose its connection state).

## SHOWCASE-016: seed/reset scripts and Docker Compose

- `tests/showcase-scripts.test.ts` (4 tests, added to `test:integration`):
  runs the compiled `dist/scripts/seed.js` and `reset.js` in temporary data
  directories: deterministic seed (byte-identical in two directories) for
  both workspaces; refusal without `--force` (exit 1, data kept) and
  overwrite with it; reset removes data, `sessions.json` and local uploads,
  writes fresh seed data and touches nothing outside the data directory;
  partial S3 configuration and an invalid `REDIS_PREFIX` are refused before
  anything changes. `reset` now also deletes the session file.
- Compose, run once on 2026-11-14 with project name `nv-r5-showcase` and
  `SHOWCASE_PORT=4055` (Docker 29.1.3); Redis and SeaweedFS publish no host
  ports (no 6379, no 3000):
  - `up --build -d`: image built (pnpm install and build inside), all three
    containers started, app healthy;
  - `/api/health`: `{"status":"ok","instance":"compose","realtime":"redis","storage":"s3","mail":"memory","redis":true}`;
  - `tests/browser/showcase.spec.ts` against it (Chromium): the landing/guards
    test and the realtime dashboard test passed; the attachment test failed
    at its 5 s assertion on the loaded host (requests through Docker's port
    forward took about 13 s), and a one-off Playwright script with longer
    waits created a task with an attachment through S3 (upload, finalize,
    task saved, notice shown);
  - Redis held `showcase:metrics:harbor`; `docker compose run --rm app node
dist/scripts/reset.js` printed "Removed 1 Redis keys under showcase:" and
    reseeded, after which no `showcase:*` key remained;
  - `docker compose down -v` removed containers, network and both volumes;
    the image was removed too.
- README: the Compose section records this run.

Remaining gap: the Compose stack is not part of CI; no screenshots.

## SHOWCASE-002: React or Svelte Inertia page

Not added. The showcase's Inertia section is one Vue app (`insights`) with
its own SSR bundle; a React or Svelte Inertia page would need a second
Inertia app (paths, root view, client entry, SSR renderer and page registry)
in the same build, which would roughly double the example's build time and
memory on a machine where one build already takes minutes. The protocol and
framework coverage exists elsewhere and is tested:
`examples/inertia-react` (React SSR, props, errors, forms, navigation,
typed actions), `examples/inertia-svelte` (Svelte SSR, validation,
navigation) and `examples/inertia-mixed` (several frameworks in one
application). React and Svelte now appear in the showcase as islands. The
README states the gap. SHOWCASE-007 and SHOWCASE-009 stay open for the
showcase itself.

## Root configuration and files for the coordinator

- `playwright.config.ts`: unchanged (showcase stays on 3124). The new
  `showcase-locale` and `showcase-islands` specs use that server;
  `showcase-resilience` starts its own process on an OS-assigned port per
  worker, so it needs no `webServer` entry.
- `playwright.services.config.ts`: unchanged (3225/3226).
- `package.json`: `tests/showcase-scripts.test.ts` appended to
  `test:integration`. It needs the showcase built (`pnpm build`).
- `examples/showcase/package.json` and `pnpm-lock.yaml`: new example
  dependencies `@nestvexa/i18n`, `@nestvexa/ui`, `react`/`react-dom` 19.3.1,
  `svelte` 5.57.3; dev `@vitejs/plugin-react` 6.1.2,
  `@sveltejs/vite-plugin-svelte` 7.3.1, `@types/react`/`@types/react-dom`
  19.3.0 (all versions already used in the workspace). No package source
  changed, so no changeset.
- Docs: `examples/showcase/README.md`, `docs/guides/i18n.md`,
  `docs/guides/islands.md`, and the stale "no island or Inertia example
  consumes it yet" line in `packages/i18n/README.md`.
- Port note: 4045 is on the Fetch "bad ports" list (undici refuses it), so a
  local `NV_SHOWCASE_RESILIENCE_PORT` must avoid it; 4050 was used.

## Verification (Windows host under heavy shared load)

- `pnpm --filter @nestvexa/example-showcase build` (tsc, vue-tsc including
  the `.tsx` island, Vite client and SSR builds with React, Vue and Svelte):
  passes.
- `pnpm exec eslint examples/showcase <new specs and test>`,
  `node scripts/boundaries.mjs`, `prettier --check` on changed files: pass.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: no error in any showcase
  file.
- `pnpm exec vitest run tests/showcase-scripts.test.ts`: 4/4 (each case
  starts several Node processes; about 150 s on this host).
- Browser, one server of mine on port 4040 (`NV_E2E_SHOWCASE_URL`), one
  browser at a time:
  - `showcase-locale.spec.ts`: Chromium 4/4, Firefox 4/4, WebKit 4/4 (the
    dashboard test first failed in WebKit only on WebKit's "EventSource ...
    due to access control checks" page error for the stream a navigation
    tears down; that exact message is now ignored in WebKit only, and the
    test passed);
  - `showcase-islands.spec.ts`: Chromium 2/2, Firefox 2/2, WebKit 2/2;
  - `showcase.spec.ts` (existing): Chromium 12/12 on the final build (an
    earlier run found the two regressions fixed above: the `dir` helper
    shadowing the sort field, and the global error filter swallowing Inertia
    validation errors).
- `showcase-resilience.spec.ts` (own process, `NV_SHOWCASE_RESILIENCE_PORT=4050`):
  Chromium 3/3, Firefox 3/3, WebKit 3/3. A first Firefox/WebKit attempt
  failed on time only (an axe call and a server start exceeded the limits
  while the host was saturated); the server start deadline (240 s) and the
  test timeouts were raised, and both browsers then passed.
- Compose smoke run: see SHOWCASE-016 above.
