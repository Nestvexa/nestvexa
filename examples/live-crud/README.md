# Live CRUD

A complete create/read/update/delete board built only with Live components and
Handlebars: a task list with search, filters, sorting, pagination, a validated
create/edit modal, confirmed deletion and an optimistic "done" toggle that rolls
back when the server refuses. The smaller `/projects` board in
[`starter-live`](../starter-live/README.md) shows a subset of these features.

## What it shows

| Feature              | How                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read                 | `task-board` renders the session's tasks; each row is a nested `task-row` component (`{{nvChild}}`) with parent-owned `@Reactive` props.                                  |
| Search, filter, sort | Writable, validated, URL-bound state (`@Url`): debounced live search, status/priority selects, sort buttons with `aria-pressed`. Changing a filter returns to page 1.     |
| Pagination           | `paginate()` with server-built links that also work without JavaScript; `nv:navigate` swaps pages in place and Back/Forward restore them.                                 |
| Create and update    | `task-editor`, a nested component rendered as an `aria-modal` dialog. One Zod schema (`@nestvexa/forms`, `validateLive`) for both modes, an error summary, inline errors. |
| Delete               | `nv:confirm` before the row's `remove` action; the board re-checks the repository before reacting to the event.                                                           |
| Optimistic UI        | `nv:optimistic.toggle="done"` projects the toggle immediately; a refused request restores the value and fires `nestvexa:rollback`.                                        |
| Component events     | Rows and the editor talk to the board with `dispatchLiveEvent(..., { to: 'task-board' })`; listeners are ordinary authorized actions with strict input pipes.             |
| Native API           | `GET /api/tasks` returns the same per-session list through an ordinary Nest controller; `GET /api/health`.                                                                |

`public/dialog.js` is small host-owned glue for the dialog: it moves focus into
the dialog on open, keeps Tab inside it, focuses the first invalid field when a
submit leaves focus nowhere, and returns focus to the opener (through the
`nestvexa:before-remove` hook) when it closes. Escape cancels through
`nv:keydown.escape`.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nestvexa/example-live-crud start   # http://127.0.0.1:3115/tasks
```

`PORT` overrides the port; the Live origin check follows it. Each browser
session gets its own seeded list of 12 tasks.

## Tests

The root Playwright suite starts this example on port **3115**
(`tests/browser/live-crud.spec.ts`; override with `NV_E2E_LIVE_CRUD_URL`).
It covers search/filter/sort/pagination without a full reload, create with
server validation and focus handling, edit and Escape-to-cancel with focus
return, confirmed delete, the optimistic toggle (held request and refused
request with rollback), per-session isolation, forged event payloads, invalid
and server-only state writes, and axe WCAG 2.1 A/AA scans of the board and the
open dialog with errors.

## Security notes

- Identity is the guest session; every repository call takes the owner from the
  server-side request, never from component state or event payloads.
- The editor's task id is a parent-owned prop inside the signed snapshot, so the
  browser cannot point it at another task. Event payloads are untrusted: the
  board accepts exactly `{ id }` with a safe id and confirms the task exists
  before announcing anything.
- Writable fields have transport bounds (`validate`); product rules live in the
  Zod schema. `errors`, `editing`, `notice` and `done` are read-only state.
- `authorize` lists every reachable action; everything else is refused.
- The optimistic projection is display-only; the server stays authoritative and
  revision checks reject replays.
- The CSP is `script-src 'self'` with no inline scripts or styles.
- Data lives in process memory (bounded) and is lost on restart; memory sessions
  are not shared between replicas. Production hosts add authentication, a
  persistent session store, a deployment secret and `Secure` cookies.

## Known gaps

- Editing and deleting need JavaScript. Pagination links and the list itself
  render without it, but there is no no-JS mutation fallback in this example
  (see [`auth-forms`](../auth-forms/README.md) and
  [`offline-progressive`](../offline-progressive/README.md) for that pattern).
- No file attachments on tasks (see [`uploads`](../uploads/README.md)).
- With the editor as a nested child component, the Live client did not move
  focus to the first invalid field after submit (focus ended on `<body>`), so
  `public/dialog.js` does it. The top-level form case is covered by the client
  itself (see `tests/browser/forms.spec.ts`).
