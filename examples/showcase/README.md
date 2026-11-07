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
- Sessions use `express-session`'s in-memory store, so they are per process.
  Two instances share realtime events and metrics through Redis, but a user
  signs in on each instance separately. A real deployment uses a shared
  session store.
- Mail goes to `@nestvexa/mail`'s memory (test) transport, shown on the
  `/app/outbox` page, or to its console transport. Both refuse
  `NODE_ENV=production`. No mail is ever sent.
- The React and Svelte Inertia pages and the React/Svelte islands of the
  master prompt's section 27 are not part of this app; see
  `examples/inertia-react`, `examples/inertia-svelte`, `examples/inertia-mixed`
  and `examples/hybrid-dashboard`.

## Pages

| Path                                          | What it shows                                                                                                                                                                                                                                                          | Packages                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/`                                           | Public HBS landing page with layout, description, canonical and Open Graph metadata, the workspace list                                                                                                                                                                | `nestvexa` (views)                                           |
| `/login`, `/logout`                           | Host-owned sign-in (scrypt, constant-time compare, one generic error, session regeneration, CSRF)                                                                                                                                                                      | host code (`src/identity.ts`)                                |
| `/app`                                        | Dashboard: a Live metrics panel refreshed in realtime (SSE), per-instance presence, a per-user notification inbox, an offline notice, and an independent server-rendered **Vue island** chart                                                                          | `nestvexa` (Live), `@nestvexa/realtime`, `@nestvexa/islands` |
| `/app/tasks`                                  | Live CRUD board: URL-bound search, filters, sorting, pagination, a nested editor dialog (focus trap, Escape, focus return), server validation, file attachments, toast, admin-only delete, assignment notifications                                                    | `nestvexa` (Live), `@nestvexa/forms`, `@nestvexa/uploads`    |
| `/app/profile`                                | Three-step profile wizard: per-step server validation, Back/Continue that keep values, consented draft autosave to the account (restored after reload, discarded on save), avatar upload, confirmation email, and a full **no-JavaScript fallback** through form posts | `nestvexa` (Live), `@nestvexa/forms`, uploads, mail          |
| `/app/outbox`                                 | The signed-in user's captured mail (memory transport only)                                                                                                                                                                                                             | `@nestvexa/mail`                                             |
| `/insights`                                   | **Vue Inertia** analytics with SSR, a deferred chart prop and a partial reload of a breakdown prop                                                                                                                                                                     | `@nestvexa/inertia`, `@nestvexa/vue`, `@nestvexa/vite`       |
| `/insights/goals`                             | Inertia form with server validation errors, flash message, admin-only create (native Nest guard), XSRF                                                                                                                                                                 | `@nestvexa/inertia`                                          |
| `/api/health`, `/api/tasks`, `/api/tasks/:id` | Native Nest REST controllers and guards next to the Nestvexa pages; workspace-scoped (another workspace's id is a 404)                                                                                                                                                 | `@nestjs/common`                                             |

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

Configuration is read and validated once at startup and never derived from a
request.

### Seed and reset

The application seeds itself on first start. With the app stopped (a running
instance keeps its data in memory and rewrites the file):

```sh
pnpm --filter @nestvexa/example-showcase seed            # refuses to overwrite
pnpm --filter @nestvexa/example-showcase seed -- --force
pnpm --filter @nestvexa/example-showcase reset           # data, local uploads, Redis keys under REDIS_PREFIX
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

The compose file is validated with `docker compose config`. Its full stack
was not brought up in this repository's test runs; the app with a real Redis
is covered by the two-instance services test below, and S3 storage by
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

- Nothing here tests the Compose stack end to end (see above).
- Presence is per instance (a property of `@nestvexa/realtime`).
- No i18n/RTL switch on the landing page (`examples/admin-i18n` covers i18n).
- No React or Svelte Inertia page, and no GraphQL operation.
- Screenshots are not part of this README.
