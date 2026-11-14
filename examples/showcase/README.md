# Nestvexa Showcase

One Nest (Express) application that ties the Nestvexa packages together as a
small, realistic product: a team workspace where two fictional product teams
manage tasks, follow live metrics, set up their profiles and read analytics.
It uses only the public entry points of the workspace packages.

The other examples each show one feature in isolation (`examples/live-crud`,
`examples/realtime-dashboard`, `examples/upload-to-s3`, and so on) and
`examples/integration-matrix` runs many routes in one process. The showcase
is the one place where the features share an identity, data, layout and
navigation, the way a real host application would use them.

## What it is, and what it is not

It is a demonstration application with seeded, non-sensitive sample data:

| Workspace              | Account            | Role   |
| ---------------------- | ------------------ | ------ |
| `harbor` Harbor Studio | `ada@harbor.test`  | admin  |
| `harbor` Harbor Studio | `ben@harbor.test`  | member |
| `summit` Summit Labs   | `cleo@summit.test` | admin  |
| `summit` Summit Labs   | `dev@summit.test`  | member |

Every account uses the public demo password `showcase-demo-2026`. Never reuse
it, or any value in this example, outside a disposable local setup.

It is **not** a production template:

- Data lives in one JSON file per data directory (`src/data.ts`, atomic
  writes, one writer process). It is a stand-in for a database.
- Sessions use `express-session`'s in-memory store by default, so they are
  per process. `SESSION_STORE=file` keeps them in the data directory so a
  restart of one process keeps users signed in (the resilience test uses it).
  Two instances share realtime events and metrics through Redis, but a user
  signs in on each instance separately. A real deployment uses a shared
  session store.
- Live component state is in process memory (the default `MemoryLiveStore`):
  after a restart, open pages must reload (the connection banner offers it).
- Mail goes to `@nestvexa/mail`'s memory (test) transport, shown on the
  `/app/outbox` page, or to its console transport. Both refuse
  `NODE_ENV=production`. No mail is ever sent.
- The React and Svelte **Inertia pages** of the master prompt's section 27
  are not part of this app (its Inertia section is Vue); see
  `examples/inertia-react`, `examples/inertia-svelte` and
  `examples/inertia-mixed`. React and Svelte **islands** are on the dashboard.
- English and Arabic cover the layout, landing, sign-in, dashboard (Live panel
  and islands), analytics and the 500 page. The task board, profile wizard,
  outbox and the goals form are still English only; they are marked
  `lang="en"` so screen readers switch voice. Event texts stored by the app
  (for example "Ben Ortiz logged a deployment") keep the language they were
  written in.

## Pages

| Path                                          | What it shows                                                                                                                                                                                                                                                                                                                                                                                 | Packages                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/`                                           | Public HBS landing page with layout, description, canonical, `hreflang` alternates and Open Graph metadata, the workspace list, an English/Arabic switch                                                                                                                                                                                                                                      | `nestvexa` (views), `@nestvexa/i18n`                                         |
| `POST /locale`                                | Language switch (a native form on every page): allowlisted locale in the `nv-locale` cookie, CSRF-checked, returns only to allowlisted paths                                                                                                                                                                                                                                                  | `@nestvexa/i18n`, `@nestvexa/forms`                                          |
| `/login`, `/logout`                           | Host-owned sign-in (scrypt, constant-time compare, one generic error, session regeneration, CSRF)                                                                                                                                                                                                                                                                                             | host code (`src/identity.ts`)                                                |
| `/app`                                        | Dashboard: a Live metrics panel refreshed in realtime (SSE), per-instance presence, a per-user notification inbox, offline and loading states, and three independent server-rendered islands: a **Vue** chart (`visible`), a **React** chart on the `@nestvexa/ui` chart wrapper (`interaction`) and a **Svelte** widget (`idle`) that hears the React chart through the islands event bridge | `nestvexa` (Live), `@nestvexa/realtime`, `@nestvexa/islands`, `@nestvexa/ui` |
| `/app/tasks`                                  | Live CRUD board: URL-bound search, filters, sorting, pagination, a nested editor dialog (focus trap, Escape, focus return), server validation, file attachments, toast, admin-only delete, assignment notifications                                                                                                                                                                           | `nestvexa` (Live), `@nestvexa/forms`, `@nestvexa/uploads`                    |
| `/app/profile`                                | Three-step profile wizard: per-step server validation, Back/Continue that keep values, consented draft autosave to the account (restored after reload, discarded on save), avatar upload, confirmation email, and a full **no-JavaScript fallback** through form posts                                                                                                                        | `nestvexa` (Live), `@nestvexa/forms`, uploads, mail                          |
| `/app/outbox`                                 | The signed-in user's captured mail (memory transport only)                                                                                                                                                                                                                                                                                                                                    | `@nestvexa/mail`                                                             |
| `/insights`                                   | **Vue Inertia** analytics with SSR, a deferred chart prop and a partial reload of a breakdown prop                                                                                                                                                                                                                                                                                            | `@nestvexa/inertia`, `@nestvexa/vue`, `@nestvexa/vite`                       |
| `/insights/goals`                             | Inertia form with server validation errors, flash message, admin-only create (native Nest guard), XSRF                                                                                                                                                                                                                                                                                        | `@nestvexa/inertia`                                                          |
| `/api/health`, `/api/tasks`, `/api/tasks/:id` | Native Nest REST controllers and guards next to the Nestvexa pages; workspace-scoped (another workspace's id is a 404)                                                                                                                                                                                                                                                                        | `@nestjs/common`                                                             |

Every authorization decision is host code in `src/identity.ts`: the session
names the account; the identity binding (account, workspace, role, session)
is what Live snapshots, realtime tokens and upload tokens are bound to; the
channel policy allows a workspace's metrics channel and a user's own
notification channel only; the Live action allowlist refuses anything not
listed and keeps `task-row.remove` admin-only.

## Run

```sh
pnpm install
pnpm --filter @nestvexa/example-showcase... build
pnpm --filter @nestvexa/example-showcase start     # http://127.0.0.1:3124
```

| Variable                                                                            | Default                          | Purpose                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                                                      | `3124`, `127.0.0.1`              | Listen address                                                                         |
| `PUBLIC_ORIGIN`                                                                     | `http://127.0.0.1:<PORT>`        | The origin browsers use; Live, actions, uploads and realtime check `Origin` against it |
| `SHOWCASE_INSTANCE`                                                                 | `standalone`                     | Instance name shown on the dashboard and in `/api/health`                              |
| `SHOWCASE_DATA_DIR`                                                                 | `<tmp>/nestvexa-showcase-<PORT>` | JSON data file and private local uploads                                               |
| `MAIL_TRANSPORT`                                                                    | `memory`                         | `memory` (outbox page) or `console`                                                    |
| `SESSION_SECRET`, `REALTIME_SECRET`                                                 | random per process               | At least 32 bytes; instances behind one load balancer must share `REALTIME_SECRET`     |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_PREFIX`                        | unset (memory broker)            | Setting `REDIS_PORT` switches realtime and the dashboard metrics and inboxes to Redis  |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset (local storage)            | Uploads go to an S3-compatible bucket; a partial configuration fails at startup        |
| `SESSION_STORE`                                                                     | `memory`                         | `file` keeps sessions in `<data dir>/sessions.json` across a restart of one process    |
| `SHOWCASE_TEST_FAULTS`                                                              | unset                            | `1` adds `/__faults/error` (the 500 page test); refused with `NODE_ENV=production`     |

Configuration is read and validated once at startup and never derived from a
request.

### Languages

English is the default; Arabic renders right to left. The locale comes from
`?lang=`, then the `nv-locale` cookie written by the switch form, then
`Accept-Language`, and only allowlisted values are used (`src/i18n.ts`,
catalogs in `locales/<locale>/<namespace>.json`). It is presentation only:
never part of the identity binding, a realtime channel or a Live snapshot.

- HBS pages: the layout prints `lang`/`dir`; `app.css` uses logical
  properties, so the header and cards mirror.
- Live: `MetricsPanel` exposes the locale as a `@Computed`, so an action or a
  realtime refresh renders in the language the browser asks for now.
- Islands: every visible string is translated on the server and passed in the
  props (SSR and hydration agree); the Svelte widget formats one sentence in
  the browser with `@nestvexa/i18n/client` from a `hydrationScript()` subset.
- Inertia: a shared `i18n` prop (`i18n.hydration(...)`, an explicit message
  subset) feeds `useTranslate()` in the Vue pages during SSR and in the
  browser; a custom root view prints `lang`/`dir`. The Vue layout has its own
  switch form (a full page load, so the whole document changes direction).

### Failure states

- **500 page**: an unexpected error on a page renders `views/error.hbs`
  (translated) with a short reference that matches the server log line; no
  error text or stack reaches the browser. API, Live and Inertia requests keep
  Nest's JSON error bodies.
- **Loading**: the panel's button is disabled and a `role="status"`
  "Saving…" message shows while a Live action is in flight (`nv:loading`).
- **Offline and server down**: `public/connection.js` shows a
  `role="status"` banner when a Live request fails without a response or the
  browser goes offline, probes `/api/health` with a capped backoff, and says
  when the server is back. A component whose last action may have reached the
  server is suspended by the Live client (`data-nv-suspended`); the banner
  then offers a reload and nothing is resent automatically.

### Seed and reset

The application seeds itself on first start. With the app stopped (a running
instance keeps its data in memory and rewrites the file):

```sh
pnpm --filter @nestvexa/example-showcase seed            # refuses to overwrite
pnpm --filter @nestvexa/example-showcase seed -- --force
pnpm --filter @nestvexa/example-showcase reset           # data, sessions, local uploads, Redis keys under REDIS_PREFIX
```

`reset` deletes Redis keys with `SCAN`/`DEL` under `REDIS_PREFIX` only. It
does not delete S3 objects: use a disposable bucket.

### Two instances with Redis

```sh
docker run -d --name showcase-redis -p 127.0.0.1:6379:6379 redis:7-alpine
export REDIS_PORT=6379 REALTIME_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
PORT=3124 SHOWCASE_INSTANCE=a pnpm --filter @nestvexa/example-showcase start
PORT=3125 SHOWCASE_INSTANCE=b pnpm --filter @nestvexa/example-showcase start
```

Sign in as Ada on one port and Ben on the other, and log a deployment: both
dashboards show the new count. "Online on this instance" is per instance by
design (`RealtimeService.presence` counts the connections of one process).

### Docker Compose

`docker-compose.yml` runs the app with Redis (`redis:7-alpine`, the image of
`.github/workflows/services.yml`) and SeaweedFS's S3-compatible API
(`chrislusf/seaweedfs`, the image of `docs/guides/production-services.md`).
Every port is published on `127.0.0.1` only.

```sh
docker compose -f examples/showcase/docker-compose.yml up --build
# reset (stop the app first):
docker compose -f examples/showcase/docker-compose.yml run --rm app node dist/scripts/reset.js
```

`SHOWCASE_PORT` moves the host port; Redis and SeaweedFS publish no host
port at all. On 2026-11-14 the stack was brought up once with
`SHOWCASE_PORT=4055 docker compose -p nv-r5-showcase -f examples/showcase/docker-compose.yml up --build -d`
(Docker 29.1.3): the image built, `/api/health` answered
`{"realtime":"redis","storage":"s3","redis":true}`, the landing and
realtime-dashboard browser tests passed against it, a task with an attachment
was created through SeaweedFS (upload, finalize, task saved; by a one-off
Playwright script with longer waits, because the spec's 5 s assertion timed
out on the loaded host), the
`showcase:metrics:<workspace>` Redis key appeared, and `node
dist/scripts/reset.js` inside the app container removed it and reseeded. The
stack was then removed with `docker compose ... down -v`. This is a manual
smoke check, not part of CI; the app with a real Redis is covered in CI by the
two-instance services test below, and S3 storage by
`tests/uploads-s3.test.ts` and `pnpm test:services`.

## What the tests prove

[`tests/browser/showcase.spec.ts`](../../tests/browser/showcase.spec.ts) runs
in Chromium, Firefox and WebKit against one process on port 3124 (root
`playwright.config.ts`), with axe WCAG 2.1 A/AA checks on every page it
visits:

- **Landing and guards**: SEO metadata and the public workspace list; every
  members-only page redirects guests to `/login`; the REST API answers guests
  with Nest's own 401.
- **Sign-in**: one generic error for a wrong password, the email kept and the
  password cleared, and a new session cookie after sign-in (no fixation).
- **Dashboard**: a deployment logged by Ben refreshes Ada's panel in the same
  document through her own request; a member of the other workspace never
  sees it; the Vue island was server-rendered and hydrated and keeps its
  selected range across Live updates; presence lists both teammates.
- **Realtime authorization**: the signed token names exactly the user's
  workspace and notification channels; another account replaying it gets
  403; a guest is refused.
- **Task board**: admin creates a task (server validation, focus on the
  first field, attachment upload), the assignee gets a realtime inbox entry
  and an email; the attachment downloads for the workspace and is a 404 for
  the other workspace, which also cannot list or fetch the task.
- **Board interactions**: search (URL-bound), status filter, empty state,
  sort with `aria-pressed`, all in one document; a member has no delete
  button; the dialog cycles focus, closes on Escape and returns focus.
- **Pagination, optimistic toggle, confirmation**: Next/Previous page links
  update the URL and `aria-current` in one document; with the toggle request
  held by the test, the row already shows the projected `done` value; a
  dismissed `nv:confirm` deletes nothing, an accepted one deletes the task
  (toast, empty state, gone from the REST list).
- **Server-side roles**: a member's forged admin-only Live action is 403
  `ACTION_FORBIDDEN`; another account replaying a snapshot is 410
  `INVALID_SNAPSHOT`; a wrong CSRF token is 403; a member's Inertia goal post
  is 403 (native guard) and a post without the XSRF header is 403.
- **Profile wizard**: per-step validation, consented autosaved drafts
  restored after a reload, Back/Continue keep values, avatar upload,
  confirmation email, draft discarded on save, owner-only avatar download.
- **No-JavaScript profile wizard**: the same three steps through ordinary
  form posts, and a cross-site post refused with 403.
- **Inertia analytics**: server-rendered HTML before JavaScript, a deferred
  chart prop, a partial reload that requests only `breakdown`, Inertia
  navigation in one document, validation errors and a flash message.
- **Offline**: the dashboard announces an offline state (`role="status"`)
  and clears it when the connection returns.

[`tests/browser/showcase-locale.spec.ts`](../../tests/browser/showcase-locale.spec.ts)
(same server, axe on every page in both directions):

- a guest switches the landing page to Arabic: `lang="ar" dir="rtl"`,
  translated text and metadata, `hreflang` alternates, a mirrored header,
  and the cookie carries the choice to the sign-in page; and back to English;
- the switch refuses unknown locales and header injection (400), a wrong CSRF
  token (403) and off-site return URLs (redirects to `/`);
- on the dashboard in Arabic, a Live action answers in Arabic, a realtime
  refresh caused by an English-speaking teammate keeps Ada's panel Arabic (in
  the same document), island captions are Arabic, and the Svelte widget
  formats an Arabic plural sentence in the browser;
- the Vue Inertia pages are server-rendered right to left and translated; an
  Inertia visit to Goals keeps the document and its direction; the Vue
  layout's own switch goes back to English.

[`tests/browser/showcase-islands.spec.ts`](../../tests/browser/showcase-islands.spec.ts):

- the page's strict CSP header (no `'unsafe-inline'`), all three islands
  server-rendered (the `@nestvexa/ui` SVG chart and its data table, the Svelte
  text), no inline `style` attributes or inline scripts, inert JSON context and
  message scripts;
- Svelte hydrates when idle and Vue when visible; React's chunk is not loaded
  until the chart is hovered; no hydration mismatches; local state in each
  island; React to Svelte through the event bridge, with a forged invalid
  event dropped; a Live update next to them leaves every island's state alone;
  axe passes and no `securitypolicyviolation` event fires.

[`tests/browser/showcase-resilience.spec.ts`](../../tests/browser/showcase-resilience.spec.ts)
starts its own showcase process (`SESSION_STORE=file`,
`SHOWCASE_TEST_FAULTS=1`, stable secrets) so it can stop it:

- a 500 page in English and Arabic with a reference and no error detail, and
  Nest's generic JSON 500 for a non-page request;
- with the Live request held by the test, "Saving…" (`role="status"`), a
  disabled button and `aria-busy="true"`, all cleared afterwards;
- the server is killed mid-session; the next click shows the panel's offline
  notice, the connection banner and a suspended component; after a restart
  the banner reports the connection back and offers a reload; the page sends
  no Live request on its own; after the reload Ben is still signed in, the
  deployment count is unchanged (the failed click was never replayed) and one
  more click adds exactly one.

[`tests/showcase-scripts.test.ts`](../../tests/showcase-scripts.test.ts)
(`pnpm test:integration`) runs the compiled `seed` and `reset` scripts in
temporary data directories: deterministic seed data, refusal to overwrite
without `--force`, `--force`, reset of data, sessions and local uploads with
nothing outside the data directory touched, and invalid S3/Redis settings
refused before anything changes.

[`tests/services/showcase-redis.spec.ts`](../../tests/services/showcase-redis.spec.ts)
runs two showcase instances against one real Redis (`pnpm test:services`
with `NESTVEXA_REDIS_PORT`; `playwright.services.config.ts` starts them on
ports 3225 and 3226):

- both instances report the Redis broker;
- a deployment logged on instance B refreshes a dashboard on instance A, a
  member of another workspace on A sees nothing, and presence stays per
  instance;
- a task assigned on A reaches the assignee's inbox on B in realtime and no
  one else's;
- a realtime token signed on A (the instances share `REALTIME_SECRET`) is
  refused on B for another account.

## Known gaps

- The Compose stack was brought up and smoke-checked once by hand (see
  above); CI does not run it.
- Presence is per instance (a property of `@nestvexa/realtime`).
- Arabic does not yet cover the task board, profile wizard, outbox and goals
  form (marked `lang="en"`), and stored event texts stay in English.
- Live state is in process memory: after a restart open pages must reload.
- No React or Svelte Inertia page (see `examples/inertia-react`,
  `examples/inertia-svelte`, `examples/inertia-mixed`), and no GraphQL
  operation.
- The React chart hydrates on hover, focus, pointer or key press; on a touch
  screen the first tap may only load it.
- Screenshots are not part of this README.
