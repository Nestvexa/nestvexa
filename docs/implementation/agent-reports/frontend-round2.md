# Agent report: frontend integrations, round 2

Branch `worktree-agent-a0a202fa3dae28bd2` (based on main `23bd02d`). Area:
integrations between the server packages and the React/Vue/Svelte frontends.
Two helper agents worked in the same worktree (UI kit wrappers; islands through
Vite and HMR tests); their commits are on this branch. Ports used: 3460-3479.

Commits (oldest first):

- `ea665d3` feat(islands): build islands through Vite (manifest plugin, SSR renderers) with an example
- `5379eac` feat(ui): shared markup contract with React, Vue and Svelte wrappers
- `f2f9741` feat(inertia): empty-response back(), session previous URL and testing helpers
- `2147c58` feat(uploads): framework-neutral browser uploader entry
- `b6e90e9` test(uploads): browser uploader against a real UploadsModule in Chromium
- `63c69c1` docs(ui): ADR 0033, framework wrapper guides and adapter tests
- `7976df6` test(vite): islands-vite browser suite and per-adapter HMR specs
- `86ad075` feat(examples): forms + uploads with the official useForm in the Inertia examples
- `89d6a40` feat(cli): scaffold SSR entries for generated Inertia roots
- `f07ce67` feat(examples): React UI kit page on the @nestvexa/ui wrappers
- `6c6474e` fix(examples): keep the kit date picker uncontrolled and document /kit
- `7f548d9` fix(ui): report date changes from text fallbacks and input events in the wrappers
- `e333c69` test(examples): tolerate WebKit's select UA-shadow CSP report in the kit spec
- `d2d2133` test(inertia): inertiaValidate with forms adapters and malformed schema results
- `297c7db` test(ui): ignore React console.timeStamp labels in Firefox and give axe more time
- `62861d3` test(ui): type-safe timeStamp console filter (final Chromium + Firefox run on this commit: 52/52)
- this report

## FORM-012 (portable form primitives in framework adapters)

- Implemented: `inertiaValidate(schema, input, { bag? })` in `@nestvexa/inertia`
  (`packages/inertia/src/validation.ts`). It runs any structural
  `{ validate(input) }` schema returning `{ ok, value | errors }` (every
  `@nestvexa/forms` adapter) and throws `InertiaValidationException`; a malformed
  result is a configuration error, never a pass. The same schema drives
  `@Precognitive(schema)`. Forms error bags reach the official `useForm().errors`
  unchanged: dotted paths stay keys, form-level errors arrive under `_form`.
- Example: `/documents` in `examples/inertia-{react,vue,svelte}`
  (`src/documents.ts`, `client/pages/Files/Documents.{tsx,vue,svelte}`): one
  `customAdapter` schema for Precognition (title, token shape) and submission,
  `defineForm({ files })` and `finalizeFileField` for the upload token, a `_form`
  error for a duplicate title.
- Tests: `tests/browser/inertia-forms-uploads.ts` (wired into
  `inertia-{react,vue,svelte}.spec.ts`): Precognition 422 then 204 on title and
  token, a JSON submit carrying the token and no file bytes, flash + stored list,
  field error after a server-side submit without a token, `_form` error for a
  duplicate title, forged token refused by finalization and shown on the field
  (asserted with `@nestvexa/inertia/testing`). `tests/inertia-testing.test.ts`
  "inertiaValidate with @nestvexa/forms adapters": parsed value from
  `customAdapter`/`zodAdapter`, `InertiaValidationException` with bag, field,
  nested (`items.0`) and `_form` keys, malformed schema results (`undefined`,
  `{ ok: true }` without value, `{ ok: false }` without errors, …) rejected as
  configuration errors. The Precognition path keeps its round-1 tests.
- Docs: `docs/guides/inertia.md#forms-and-uploads-with-the-official-useform`,
  `docs/guides/forms.md` §11, `packages/inertia/README.md`, example READMEs.
- Remaining gap: the second outstanding issue (form view helpers from
  EJS/Pug/Nunjucks templates) was not in this assignment and is not addressed.
  Server actions + forms bindings for React hooks are covered by ACT/SPA-003
  rows, not here.

## UP-008 (forms + React/Vue/Svelte Inertia uploads)

- Implemented: `@nestvexa/uploads/browser` (`packages/uploads/src/browser/index.ts`,
  `tsconfig.browser.json`, `./browser` export): `uploadFiles`/`uploadFile`
  (chunked sessions with per-chunk SHA-256 or presigned direct PUT, progress
  `{ loaded, total, percentage, file }`, `AbortSignal`, bounded retries of
  transient chunk failures, server-side discard of every token/session of a
  failed or aborted batch, cleanup requests not cancelled by the aborted signal),
  `BrowserUploadError` with closed codes, `browserUploadMessage`, `readCookie`.
  Endpoint must be a same-origin path, purpose must match the server pattern;
  both refused before any request. No framework/Node/Nest import (new rule in
  `scripts/boundaries.mjs`).
- Inertia integration: the three examples upload through it with a progress
  bar, submit the token with the official `useForm`, finalize with
  `finalizeFileField`; upload codes become field errors. The example XSRF
  guards accept the same token in `x-nestvexa-csrf`; identity is the
  express-session id.
- Tests: `tests/uploads-browser.test.ts` (real `UploadsModule`, Chromium:
  multi-file chunked upload with monotonic progress and finalizable tokens,
  single use, server code + discard of earlier files, abort releasing quota,
  wrong CSRF `CSRF_REJECTED`, unknown purpose, unsafe endpoints/purposes with no
  network request, another identity gets `UPLOAD_NOT_FOUND`);
  `tests/browser/inertia-forms-uploads.ts` (React, Vue, Svelte).
- Docs: `docs/guides/uploads.md` "SPA frontends", `packages/uploads/README.md`
  (API table, caveats, testing), changeset `uploads-browser-entry.md`. The
  README already cites `services-evidence-2026-11-02.json` (round 1).
- Remaining: no framework hooks (pages hold progress in their own state); no
  resumable sessions across reloads (as the Live client).

## INERT-002 (documented gaps: empty-response back, previous URL, testing helpers)

- Empty response: `InertiaInterceptor` redirects an Inertia request whose
  handler returned `undefined` back (302, 303 after PUT/PATCH/DELETE), option
  `emptyResponse: 'back' | 'passthrough'` (default `back`). Skipped for
  `@InertiaPage` routes, handlers with `@Res()`/`@Next()` (route-args metadata)
  and handlers declaring `@HttpCode`, `@Redirect`, `@Render` or `@Sse`; plain
  requests untouched.
- Previous URL: `previousUrl` option (default true): each `200`, non-prefetch
  GET page response stores its relative URL in the host session
  (`InertiaSessionKey.previousUrl`); `back()` (and the validation filter) uses
  same-host `Referer`, then the stored URL, then the fallback.
  `InertiaService.previousUrl(request)`. Stored values are re-validated
  (`storablePath`: single leading `/`, no backslash/control chars, ≤ 2048).
- Testing helpers: `@nestvexa/inertia/testing` (`packages/inertia/src/testing.ts`):
  `inertiaHeaders`, `readInertiaPage` (X-Inertia JSON, v3 page script, legacy
  `data-page` attribute; supertest/light-my-request/fetch-like/string inputs),
  `assertInertia` → `AssertableInertiaPage` (`component`, `url`, `version`,
  `prop`, `has`, `missing`, `where`, `hasErrors`, `hasNoErrors`, `flash`,
  `deferred`), `InertiaAssertionError`.
- Tests: `tests/inertia-testing.test.ts` (19 tests incl. `inertiaValidate`, Express + Fastify over real
  HTTP; negative: prefetch/404 not stored, foreign Referer ignored, tampered
  session value `//evil.example/steal` ignored, `@Res`/`@HttpCode`/plain
  requests untouched, invalid options rejected, malformed page inputs rejected,
  failure messages). Existing suites rerun: `inertia-http`, `inertia-security`,
  `inertia-golden`, `inertia-precognition`, `inertia-protocol` (245 tests pass
  with the change).
- Docs: `docs/guides/inertia.md` (new sections + parity matrix rows),
  `docs/getting-started/inertia.md`, `docs/migration/from-inertia-laravel.md`,
  ADR 0018 note, `packages/inertia/README.md`; changeset
  `inertia-empty-response-testing.md`.
- Remaining (unchanged): `shareOnce()` sugar, error-page helper; scroll
  management/progress bar not separately asserted.

## SPA-006 (scaffolds, HMR per adapter)

- CLI SSR scaffolding: `nestvexa add react|vue|svelte` now writes
  `client/<fw>/ssr.ts[x]` (`render` from `createReactSsrRender` /
  `createVueSsrRender` / `createSvelteSsrRender`), `build:<fw>` also runs
  `vite build --ssr … --outDir dist/<fw>/ssr`, and the generated
  `inertia.config.ts` renders in-process from `dist/<fw>/ssr/ssr.js` in
  production (`moduleSsrRenderer`, 3 s timeout, `fallback`) when the bundle
  exists (`packages/cli/src/templates-app.ts`, `features.ts`). Test:
  `tests/cli-generators.test.ts` (asserts the files, scripts and config; the
  existing "type-checks every generated server and client file" and "boots the
  generated app" tests pass with the SSR entries; 18/18). Docs:
  `packages/cli/README.md`, `docs/reference/cli.md`; changeset
  `cli-inertia-ssr-entries.md`. Gap: development stays client-rendered (the CLI
  roots use standalone Vite dev servers), an existing `inertia.config.ts` is not
  rewritten, and no test builds a scaffolded root with Vite (type-check + boot
  only).
- Per-adapter HMR (helper): `tests/browser/inertia-hmr.spec.ts` with
  `tests/browser/hmr-fixture.mjs` (runs each example in `--dev` from a
  disposable copy under `artifacts/hmr-inertia-<fw>`, edits a probe page on
  disk): SSR markup + Vite client through the dev middleware, hot update without
  a full reload (window marker and local state survive), dev SSR renders the
  edit. Root Playwright entries on 3476/3477/3478.
  Result (local config on 3475-3479, this round): all `inertia-hmr.spec.ts`
  tests passed in Chromium, Firefox and WebKit (6 tests x 3 browsers, in the
  same run as the islands-vite suite: 31 passed, 2 failed, both islands-vite,
  see INERT-016).
- Source maps and CSR-only tests were closed in round 1.

## INERT-016 (islands through @nestvexa/vite)

- Helper work: `islandsVitePlugin` (records an esbuild-style metafile of the
  Vite client build, keeps entry mount exports, writes
  `.vite/islands-manifest.json`, `islands-analysis.json`, `islands-metafile.json`;
  fails on a foreign framework runtime or budget overrun),
  `createViteIslandManifest` (Vite manifest → island bundle paths, unsafe
  bases/files rejected), `moduleIslandRenderers` (SSR renderers from a Vite SSR
  bundle or `ssrLoadModule`) in `packages/islands/src/build.ts`/`index.ts`.
  Example `examples/islands-vite` (production manifest-only loader with nonce
  tags through `ViteAssets`, and `--dev` with `createViteDevServer`).
- Tests: `tests/islands-vite.test.ts` (unit), `tests/browser/islands-vite.spec.ts`
  (SSR markup, hydration without mismatch for React/Vue/Svelte, manifest-only
  loading, tampered props refused, dev SSR); root Playwright entries 3479
  (prod) and 3475 (dev). Existing `tests/islands.test.ts` passes.
  Result: in the combined run with the five dev/prod servers, 2 islands-vite
  tests failed (Firefox: browser crash at context close with a GFX
  compositor error; WebKit: a click waiting for "stable" past 30 s); rerun in
  isolation against a hand-started production server, the production tests
  passed in Firefox and WebKit with `--repeat-each=2` (16/16). Chromium passed
  in the combined run. Treat these as load flakes on this host.
- Docs: `docs/guides/islands.md`, `docs/guides/vite.md`,
  `packages/islands/README.md`, `examples/islands-vite/README.md`; changeset
  `islands-vite-builds.md`.
- Gap: the esbuild path of `hybrid-dashboard` is unchanged (both supported);
  the CLI islands template already uses Vite but does not yet use
  `islandsVitePlugin`.

## EXT-020 / EXT-017 / EXT-016 (UI kit SPA adapters)

- Helper work (ADR 0033 `docs/adr/0033-ui-kit-framework-wrappers.md`):
  `@nestvexa/ui/markup` (validated element trees shared by HBS helpers and
  wrappers; HBS output byte-identical), `@nestvexa/ui/react`, `/vue`, `/svelte`
  subpath entries (React/Vue/Svelte optional peers; Svelte ships `.svelte`
  source under the `svelte` condition) for dialog/drawer, dialog trigger, tabs,
  menu, toast region, date picker and data table pieces; behavior through
  `connectUi(element)` of `@nestvexa/ui/browser`. Boundary rules keep the
  server entry and markup contract framework-free.
- Tests: `tests/ui-adapters.test.ts` (SSR parity with the HBS helpers for all
  three frameworks, hydration under strict CSP, keyboard behavior, callbacks,
  axe, unmount/remount), existing UI tests unchanged and passing.
  Verification in this round found two WebKit failures the helper had not
  caught; both fixed in `7f548d9`: (1) Playwright WebKit on Windows has no
  native date control, so `<input type="date">` is a text input that commits
  with `input` only; the wrappers' `DatePicker` checked `target.type` and
  listened to `change`, so `onChange` never fired. They now match
  `input[type="date"]`, listen to `input` and `change` and report each value
  once. (2) WebKit fires a `style-src-attr` violation for the UA shadow tree
  of a script-created `<select>` (reproduced on a bare strict-CSP page with
  `document.createElement('select')`); the remount test recreates the table
  filter, so the test ignores that one directive in WebKit only.
  `NV_UI_BROWSERS=webkit pnpm exec vitest run tests/ui-adapters.test.ts`:
  27/27 after the fix (4-6 failures before). In Firefox every React test
  failed because React's development build logs `console.timeStamp('Hydrated')`
  and the test's hydration filter matched it; the filter now skips
  `timeStamp` messages (`297c7db`): Chromium + Firefox 52/52.
- Runnable SPA example (mine): `/kit` in `examples/inertia-react`
  (`src/kit.ts`, `client/pages/Kit/Index.tsx`), tested by
  `tests/browser/inertia-react-ui-kit.spec.ts` (axe before/after, CSP, dialog,
  tabs, menu, toast, date picker, data table search/filter/select-all).
- Docs: `packages/ui/README.md`, `docs/guides/ui-kit.md`, pointers in
  `docs/guides/{react,vue,svelte}.md`; changeset `ui-framework-adapters.md`.
- Remaining: chart wrapper and form-field wrappers (EXT-017) still missing;
  accordion, popover, tooltip, breadcrumbs, badge, alert, file upload, wizard
  are HBS-only; Vue/Svelte wrappers have no runnable example page (tests only).

## Test commands and results

Vitest (all passing at the end):

- `pnpm exec vitest run tests/inertia-testing.test.ts tests/inertia-http.test.ts tests/inertia-security.test.ts tests/inertia-golden.test.ts tests/inertia-precognition.test.ts tests/inertia-protocol.test.ts`: 6 files, 245 tests.
- `pnpm exec vitest run tests/uploads-browser.test.ts`: 6/6 (Chromium).
- `pnpm exec vitest run tests/cli-generators.test.ts --testTimeout=900000`: 18/18 (includes type-checking and booting the generated roots with SSR entries). Under heavy load the default timeouts of the type-check/boot tests (and `tests/cli.test.ts` "builds, boots and serves a working Live counter") were exceeded once; they pass when the host is not saturated.
- `pnpm exec vitest run tests/ui-adapters.test.ts tests/ui-primitives.test.ts tests/ui-helpers.test.ts tests/islands-vite.test.ts tests/islands.test.ts`: 113/113 (Chromium); `NV_UI_BROWSERS=webkit … tests/ui-adapters.test.ts`: 27/27 after `7f548d9`; `NV_UI_BROWSERS=chromium,firefox …`: 52/52 after `297c7db` (before it, every React test failed in Firefox because React's development `console.timeStamp('Hydrated')` labels matched the test's hydration-error filter).

Playwright (uncommitted local configs on 3460-3479; root config not run):

- `tests/browser/inertia-{react,vue,svelte}.spec.ts --grep "forms . uploads"` + `tests/browser/inertia-react-ui-kit.spec.ts` against the three examples (`start:e2e` on 3460/3461/3462; React without its SSR process, so SSR fell back to client rendering): Chromium 10/10; Firefox 10/10; WebKit failed the kit date step (fixed in `7f548d9`) and the Vue upload-failure test (a click waiting for "stable"; after giving the second upload a different file name the Vue WebKit suite passed 9/9 with `--repeat-each=3`); kit spec after the fixes: Chromium, Firefox, WebKit pass.
- `tests/browser/islands-vite.spec.ts` + `tests/browser/inertia-hmr.spec.ts` (`playwright.vite-local.config.ts`, 3475-3479): 31 passed, 2 islands-vite load flakes (see INERT-016), HMR 18/18 across the three browsers.
- `pnpm lint` parts run per changed path (`eslint` on changed sources/tests), `node scripts/boundaries.mjs`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`, `pnpm docs:build` (201 documents), `pnpm size:check` (45 445 / 49 152 gzip bytes): clean.

## Coordinator notes

- Root `playwright.config.ts`: new webServer entries 3475 (islands-vite dev),
  3476-3478 (HMR fixtures), 3479 (islands-vite prod). New specs
  `inertia-react-ui-kit.spec.ts` and the forms/uploads suite run against the
  existing 3106/3107/3108 entries.
- Root `package.json`: `tests/inertia-testing.test.ts` (integration +
  security), `tests/uploads-browser.test.ts` (integration),
  `tests/ui-adapters.test.ts`, `tests/islands-vite.test.ts` (groups set by the
  helpers).
- Dependencies: examples `inertia-{react,vue,svelte}` → `@nestvexa/forms`,
  `@nestvexa/uploads`; `inertia-react` → `@nestvexa/ui`; new example
  `examples/islands-vite`. `pnpm-lock.yaml` updated.
- Package exports added: `@nestvexa/inertia/testing`,
  `@nestvexa/uploads/browser`, `@nestvexa/ui/{markup,react,vue,svelte}`.
- Expected conflicts: `docs/guides/inertia.md` parity matrix, example
  `main.ts` files, `package.json` test lists, `scripts/boundaries.mjs`,
  `playwright.config.ts`.
- Behavior change: Inertia requests whose handler returns `undefined` now get a
  redirect back by default (`emptyResponse: 'passthrough'` restores the old
  behavior).
