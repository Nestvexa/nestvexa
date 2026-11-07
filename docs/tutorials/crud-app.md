# Tutorial: build a CRUD app with Live

You will build a project board: a Live component that searches, sorts and
paginates server data, creates records with server-side validation, deletes rows
through child components and keeps every decision on the server. The finished code
is the `/projects` page of [`examples/starter-live`](../../examples/starter-live/README.md)
(`src/projects.ts`, `views/project-board.hbs`, `views/project-row.hbs`), exercised
by [`tests/browser/projects.spec.ts`](../../tests/browser/projects.spec.ts).

## 1. Start from a generated resource

In a Nest app already wired with `npx nestvexa init` (see the
[CLI reference](../reference/cli.md)), generate a resource:

```sh
npx nestvexa make:resource Project --dry-run   # preview the plan
npx nestvexa make:resource Project
```

This creates three files and edits nothing else:

| File                                     | Contents                                                           |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `src/project/project.service.ts`         | `ProjectService`: an in-memory `list`/`create`/`remove` store      |
| `src/project/project-table.component.ts` | `ProjectTableComponent` (`project-table`): a draft field, `create` |
| `views/components/project-table.hbs`     | A form bound with `nv:model`/`nv:submit` and a keyed list          |

The CLI then prints the two steps it does not do for you: provide `ProjectService`
through a module imported by your Live registration, register the component and
authorize its actions. The generated service is a placeholder; no schema or
migration is generated, so replace it with your own data access.

## 2. Register and authorize the component

Live actions are only reachable when the host policy says so. The `authorize`
callback receives the resolved identity, the component name and the action name;
`$mount` and `$sync` are framework actions you must allow explicitly.

```ts
NestvexaModule.forRoot(
  { views: { root, layout: 'layout' }, live: { enabled: true } },
  {
    components: [ProjectTableComponent],
    imports: [ProjectModule], // provides and exports ProjectService
    useFactory: () => ({
      origin: 'https://app.example.com',
      resolveIdentity, // host session → { binding, csrfToken }
      authorize: (identity, component, action) =>
        component === 'project-table' &&
        ['$mount', '$sync', 'create'].includes(action),
    }),
  },
);
```

Mount it from an ordinary controller with `LiveRuntime.mount(Component, request)`
and render the returned `SafeHtml` in a view; the starter does this in
`Pages.projects()` in `src/main.ts`. Private pages must send
`Cache-Control: no-store`.

## 3. Scope data to the caller

The starter's repository keys every list by an owner derived from the server-side
session, never from the browser:

<!-- snippet: examples/starter-live/src/projects.ts -->

```ts
function owner(request: unknown): string {
  const id: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'sessionID')
      : undefined;
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return id;
}
```

Components inject the repository and `REQUEST` through normal Nest DI. In a real
app this is where your ORM query and resource-level authorization go: the Live
`authorize` callback decides who may call `create`, your service decides which
rows that user may see or change.

## 4. Declare writable, validated state

Only fields marked `writable` can be changed by the browser, and each one carries a
pure validator that runs before the state transaction. `@Url` mirrors a field into
the query string so links and reloads keep the search:

<!-- snippet: examples/starter-live/src/projects.ts -->

```ts
  @Url({ key: 'q', history: 'replace', except: '' })
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  query = '';
```

Fields such as `errors` stay read-only `@State()`: a forged update returns `422`
and never reaches your action. See [URL and session state](../guides/url-session-state.md).

## 5. Search, sort and paginate on the server

`paginate()` computes a bounded page window; computed getters derive the visible
rows from the authoritative data on every render:

<!-- snippet: examples/starter-live/src/projects.ts -->

```ts
  @Computed() get pagination() {
    return paginate({
      page: this.page,
      perPage: 4,
      total: this.visible().length,
    });
  }
```

The search box synchronizes with a debounced model and still works as a plain GET
form without JavaScript:

<!-- snippet: examples/starter-live/views/project-board.hbs -->

```hbs
  <form method="get" action="/projects" role="search" nv:submit="search">
    <label for="project-search">Search projects</label>
    <input
      id="project-search"
      name="q"
      value="{{query}}"
      maxlength="40"
      nv:model.live.debounce.250ms="query"
    />
```

Sorting is two actions (`sortByName`, `sortByStatus`) that set a validated field
and reset the page. See [computed values](../guides/computed-values.md) and
[`nv:sort`](../reference/nv-sort.md) for drag-and-drop ordering.

## 6. Create records with server validation

The `create` action validates against current data, writes errors into read-only
state and dispatches a toast event on success:

<!-- snippet: examples/starter-live/src/projects.ts -->

```ts
  @Action() create(): void {
    const name = this.draftName.trim();
    const errors: Record<string, string> = {};
    if (name.length < 2) errors['name'] = 'Enter at least 2 characters.';
```

The template marks the invalid field with `aria-invalid` and an `role="alert"`
message. For schema-based rules use `zodAdapter` or `classValidatorAdapter` with
`validateLive` from `@nestvexa/forms/live`; see the [forms guide](../guides/forms.md).

## 7. Delete through child components and events

Each row is a child component (`children: { row: ProjectRow, toast: ProjectToast }`)
rendered with `{{nvChild "row" id projectId=id name=name status=status}}`. The row
owns its delete action, asks for confirmation with `nv:confirm` and tells the board
through an event. The board treats the event payload as untrusted and re-checks:

<!-- snippet: examples/starter-live/src/projects.ts -->

```ts
  removed(@ActionInput(ProjectReferencePipe) input: ProjectReference): void {
    // Event payloads are untrusted: only react if the project is really gone.
```

A confirmation prompt is UX, not authorization. See
[nested components](../guides/nested-components.md) and
[`nv:confirm`](../reference/nv-confirm.md).

## 8. Effects: downloads, flash messages and redirects

`downloadLive` streams a CSV export, `flashLive` + `redirectLive` archive and
navigate, and `consumeLiveFlash(request)` shows the message on the next page.
The export prefixes cells starting with `=`, `+`, `-` or `@` to defuse spreadsheet
formula injection. See [Live effects](../guides/live-effects.md).

## 9. Test it

```sh
pnpm build
pnpm exec playwright test tests/browser/projects.spec.ts --project=chromium
```

The spec drives real Nest routes: debounced search updating the URL, server
sorting, validation messages, escaped user input, pagination with Back, optimistic
stars with rollback, confirmed deletion, CSV download, the flash redirect, an axe
accessibility check and pagination without JavaScript. The [testing guide](../testing/guide.md) shows how to
write the same kind of tests for your app.

## Limits

> **Known gap:** this tutorial uses the single-process `MemoryLiveStore`. Run one
> process or use sticky sessions, and expect a restart to invalidate open pages.
> For several replicas use `RedisLiveStore`
> ([multiple replicas](../deployment/multi-replica-redis.md)).

> **Note:** `@Action({ idempotent: true })` replays an identical retry
> instead of running it twice, and `concurrency` selects how overlapping calls
> are handled ([ADR 0031](../adr/0031-live-protocol-evolution-and-action-replay.md)).
> Neither makes an external effect exactly-once, so use database transactions for
> irreversible effects.

> **Known gap:** there are no Prisma, TypeORM or Drizzle examples (DATA-014), and
> `@nestvexa/forms` has no pipe binding a schema to `@ActionInput` arguments
> (FORM-005). The generated resource has no edit action.
