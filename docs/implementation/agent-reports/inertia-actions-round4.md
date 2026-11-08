# Agent report: Inertia and universal actions remainder, round 4

Branch `worktree-agent-ac112eb8c8dc6f05d` (based on main `acf4168`). Area: the
Inertia rows INERT-001/002/003/007/013, the SPA adapter rows SPA-001/002/003
and the actions codegen rows ACT-001/013/014. Ports used: 3920-3925 (local
Playwright config only; nothing in the root config changed).

Commits: `728e1f3` feat(inertia) Precognition guard labels and
`validateFiles()`; `0ba9e3c` feat(examples) Vue/Svelte tours, scroll and
progress, typed actions on Inertia pages; `b715113` test(pack) bindings from
the packed tarball; `1618903` docs(guides); merges of `main` `0703d80`
(conflict in `packages/inertia/README.md`, resolved into main's new layout
with a Precognition bullet) and `e90a1d5` (main `e93af58`; conflict in
`.gitignore` only, both sides kept; main's JSON-page `Vary` change composes
with `Vary: Precognition`); this report.

## INERT-007 (Precognition: multipart `validateFiles()`, guard rejections)

- Guard rejections keep `Precognition: true`. The official client
  (`laravel-precognition` 2.1.1) throws "Did not receive a Precognition
  response" for any reply without that header, so a CSRF/auth/throttle guard
  rejection used to surface as an error instead of reaching
  `onUnauthorized`/`onForbidden`. `packages/inertia/src/precognition-http.ts`
  adds `PrecognitionMiddleware` (registered by `InertiaModule.configure` for
  every route: labels `Precognition: true` requests with `Precognition: true`
  and `Vary: Precognition` on the raw Node response before guards run) and
  `PrecognitionGuard` (global `APP_GUARD`, never rejects: keeps the label on
  `@Precognitive` routes, removes it on other routes so their handler replies
  never look validation-only, as upstream where only the middleware adds it).
  Header helpers `markPrecognitionResponse`/`unmarkPrecognitionResponse` in
  `precognition.ts` work for Express and Fastify (`reply.raw`).
- Multipart validation. `@Precognitive(validator, { interceptors })` runs the
  listed Nest interceptors (classes created once through `ModuleRef`, or
  instances) around the validation for Precognition requests only, so a route's
  `FileInterceptor` parses the `multipart/form-data` body the client sends after
  `validateFiles()`; ordinary submissions still use the route's own
  `@UseInterceptors`. The default input merges multer-style `request.file` /
  `request.files` (single, `array()`/`any()` lists grouped by field, `fields()`
  record) into the body under their field names, never producing prototype
  keys. An interceptor that never calls `next.handle()` is a configuration
  error (500, still labelled). Option validation rejects non-interceptor
  entries.
- Tests: `tests/inertia-precognition.test.ts`, new describe "Precognition guard
  rejections and multipart validateFiles()" (Express and Fastify): route,
  controller and app-guard 401/403 keep the header and never run the handler;
  undeclared routes carry no Precognition header whether rejected or reached;
  multipart file validation (422 for a bad type, 204 for a good one,
  `Precognition-Validate-Only` filtering, JSON without the file) without
  running the handler, then a real submission through the route interceptor;
  multer's 413 for an oversized file keeps the header (Express only: multer is
  the Express parser); multer `request.files` lists (`array()`/`any()`) and
  records (`fields()`) merge by field name, override a same-named body field
  and never produce `__proto__` (or change the input's prototype); a stuck
  interceptor gives 500. `tests/inertia-support.ts`
  `send()` accepts raw Buffer bodies and `boot()` a `configure` hook (Fastify
  content-type parser).
- Browser: `tests/browser/inertia-react.spec.ts` "validateFiles() sends
  multipart Precognition requests that the FileInterceptor parses":
  `examples/inertia-react` `/uploads` uses `useForm('post', '/uploads',
data).validateFiles()`; choosing a file sends a multipart request with
  `Precognition-Validate-Only: document` and the XSRF token; HTML is rejected
  with the inline error, a text file gets 204, nothing is stored.
- Docs: `docs/guides/inertia.md` (guard section, "Files: `validateFiles()`",
  parity rows), `docs/guides/react.md`, `packages/inertia/README.md`;
  changeset `.changeset/inertia-precognition-files-guards.md` (minor).
- Remaining gap: if an application registers its own global guard _before_
  `InertiaModule`'s and it rejects a `Precognition: true` request to a route
  without `@Precognitive`, that reply keeps the middleware's label (the
  removal runs in `PrecognitionGuard`). Precognitive routes are always right.

## INERT-013 (and parents INERT-001/002/003): client-owned features with every official client

- Vue and Svelte examples gained the feature tour React already had:
  `/features/tour` (`examples/inertia-{vue,svelte}/src/features.ts`, pages
  `client/pages/Features/{Tour,Target,Slow,Remember,Once,Todos,Long}.{vue,svelte}`):
  instant visits (`component="Features/Slow"`), `router.visit`/`router.post`, a
  `method="post"` link, view transitions, `useRemember` plus a remembered
  `useForm`, `once()` props, `optimistic` visits with rollback, and long pages
  with a `scroll-region` element. React gained `Features/Long`, a "Slow page"
  link and a "Quiet slow visit" button (`showProgress: false`).
- Shared suites in `tests/browser/inertia-feature-tour.ts`:
  - `defineFeatureTour` (Vue, Svelte): instant visit shown while the request is
    parked, manual visits and non-GET links (methods, bodies, XSRF header),
    view transitions (`document.startViewTransition` counted when the browser
    has it), remembered state across back navigation, once props
    (`X-Inertia-Except-Once-Props`, value reused), optimistic add and rollback.
  - `defineScrollAndProgress` (React, Vue, Svelte): visits reset the window and
    the `scroll-region` element to 0; back restores both from the history entry
    (state-based waits on `history.state.documentScrollPosition` /
    `scrollRegions`, no fixed sleeps); `preserveScroll` keeps both; a `#anchor`
    visit scrolls the anchor into view and resets the region; the progress bar
    appears after the client's delay in the configured colour (`#1d4ed8`) while
    the request is held and is removed afterwards; `showProgress: false` marks
    the document busy but keeps the bar hidden.
  - Wired in `tests/browser/inertia-vue.spec.ts`,
    `tests/browser/inertia-svelte.spec.ts` and
    `tests/browser/inertia-react-features.spec.ts` (which now imports the
    shared `gate` helper).
- Docs: `docs/guides/inertia.md` parity table (instant visits, once props,
  client features, scroll management and progress now verified on all three),
  `docs/guides/react.md`, `docs/guides/vue.md`, `docs/guides/svelte.md`.

## SPA-003 (and SPA-001/002): typed action bindings on Inertia pages

- Each Inertia example has a `notes` action group (`src/actions.ts`:
  `NotesActions.add`, bounded per-session storage, typed validation issue on
  `text`), registered with `ActionsModule.register` (session identity, the
  session XSRF token as CSRF token, exact origin) and a `/features/actions`
  Inertia page. `scripts/codegen.mjs` runs before each build and writes the
  git-ignored `client/generated/` (React hooks / Vue composables / Svelte
  stores). The pages use `useNotesAdd()` (React hook), `useNotesAdd()` (Vue
  composable) and `notesAdd()` (Svelte store) with the page prop as
  `initialData`, an optimistic value and the typed issue path;
  `client/actions.ts` reads `XSRF-TOKEN` per call (SSR-safe).
- Browser: `defineTypedActionsSuite` in `tests/browser/inertia-feature-tour.ts`
  (React, Vue, Svelte): request body and `x-nestvexa-csrf` header, optimistic
  state while the call is parked, success, rollback with the typed error
  message and `aria-invalid`, server-rendered result after a reload, and `403`
  for calls without the token or from another origin (no side effect).
- Docs: "Typed server actions" sections in `docs/guides/react.md`, `vue.md`,
  `svelte.md`; `docs/guides/server-actions.md` "Example and tests".
- `examples/inertia-{react,vue,svelte}/package.json` add
  `@nestvexa/actions: workspace:*` and the `codegen` script (lockfile updated).

## ACT-014 (and ACT-001/013): bindings from the packed tarball

- `tests/pack-consumers/consumer.ts` (run by `pnpm test:pack`) now generates
  the base client plus `live`, `react`, `svelte` and `vue` targets from the
  packed `@nestvexa/actions` codegen, asserts the emitted file list, then
  type-checks `tests/pack-consumers/bindings-check.ts` next to the generated
  files with the consumer's own compiler options against the packed
  declarations only (including `@ts-expect-error` contracts: input types from
  the server signature, unknown fields rejected, issue paths limited to input
  fields, `Date` outputs typed as strings, optimistic values typed as the
  output, element helper input typed), and runs it in a child process against
  the packed `ActionsModule` route: the React hook under
  `react-dom/server`, the Vue composable in an effect scope (state ref, scope
  disposal) and the Svelte store (subscribe statuses, settled result).
- `scripts/pack.mjs`: the full consumer installs `react`/`react-dom` 19.3.1,
  `vue` 3.5.44 and `@types/react(-dom)` 19.3.0 (versions already used in the
  workspace) and copies `bindings-check.ts`; the full smoke timeout is 900 s.
- Remaining gap: Live/HBS element helpers need a DOM; from the tarball they are
  type-checked and their module shape is checked in Node, but they run in the
  browser only through `tests/browser/actions.spec.ts` (workspace build).

## Test commands and results

The host was heavily loaded throughout (a bare `node -e` took 11 s), so
runs were targeted.

- `pnpm exec vitest run tests/inertia-precognition.test.ts`: 44/44 passed
  (Express and Fastify).
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: clean.
- `pnpm lint` (eslint over packages, tests, examples, scripts, apps and the
  boundaries check), after the first merge of `main`: clean.
- After merging `main`, `tsc -p tsconfig.tests.json` reports errors only in
  main's new `tests/assets-integrity.test.ts` and
  `tests/kernel-integration.test.ts`, because this worktree's `dist` of the
  packages those tests import is older than main's sources; none touch files
  of this branch (the pre-merge run was clean).
- `pnpm exec prettier --check` on the changed docs; `pnpm docs:build`: 229
  documents checked, passed.
- Example builds (`pnpm --filter @nestvexa/example-inertia-{react,vue,svelte}
build`, including `vue-tsc` and `svelte-check --fail-on-warnings` and the
  codegen step): passed.
- Playwright, Chromium (local config on ports 3920-3922):
  `tests/browser/inertia-{vue,svelte,react-features,react}.spec.ts` with the
  new suites: feature tour (Vue, Svelte, 6 tests each), scroll management and
  progress (3 tests x 3 frameworks), typed server actions (3 frameworks) and
  the React `validateFiles()` upload test all passed (the progress test and
  the actions test were fixed and re-run after their first run: the bar's
  container has zero height, and `getByLabel('Note')` also matched the
  "Notes" list).
- After the second merge of `main` (one browser and one worker at a time,
  same 25 tests: tour, scroll and progress, typed actions, `validateFiles()`):
  - Firefox: 25/25 passed.
  - WebKit: 18/25 passed on the first run. On `--last-failed`, 6 of the 7
    failures passed. The one left is "Inertia Vue client features tour ›
    manual visits and non-GET links use the requested methods". It failed
    both times in the same way: after an Inertia visit back to
    `/features/tour`, the click on "Post with router.post" waits forever for
    the button to become _stable_. The page snapshot is complete and correct.
    All 7 first-run failures were of this kind (clicks stuck on the
    stability check, and `scroll-region` positions never saved to history),
    which means WebKit was not producing frames on the starved host. The
    Svelte twin of the failing test and the same flow in Chromium and
    Firefox pass. This test still needs a WebKit run on an unloaded host
    before it can count as verified there.
- `pnpm exec vitest run tests/inertia-precognition.test.ts` after the second
  merge: 44/44 passed.
- `pnpm test:pack` (PowerShell): the tarballs packed and the pnpm full
  consumer installed and compiled, but the smoke hit the old 300 s limit on
  this host. Run by hand in that consumer directory, `node dist/consumer.js`
  passed every section, including "Packed actions consumer passed: explicit
  group route, generated types from the tarball, typed client and
  type-checked React/Vue/Svelte/Live bindings" (1157 s). The full smoke
  limit is now 900 s. The npm and minimal consumers were not re-run after
  that; they are unchanged by this work apart from the timeout.
