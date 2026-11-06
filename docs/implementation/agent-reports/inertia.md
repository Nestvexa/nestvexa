# Agent report: Inertia v3 protocol completeness and official-client coverage

Area: ledger groups INERT and SPA. Branch `worktree-agent-a0d69ee2e1037ab38`.
Official clients installed: `@inertiajs/core`/`react`/`vue3`/`svelte` 3.10.0
(Precognition via the bundled `laravel-precognition` 2.1.1).

Commands run (results at the end of this report): `pnpm exec vitest run
tests/inertia-golden.test.ts tests/inertia-precognition.test.ts
tests/vite-manifest.test.ts tests/vite-builds.test.ts`; Playwright with an
uncommitted local config on ports 3200-3212/13800 for
`tests/browser/inertia-react-features.spec.ts`, `inertia-react.spec.ts`,
`inertia-vue.spec.ts`, `inertia-svelte.spec.ts`, `inertia-mixed.spec.ts`.

## INERT-002 (adapter completeness)

- Precognition: implemented (see INERT-007).
- Client-owned features verified with the official React client in the
  browser: prefetch (hover, cache reuse), instant visits, manual visits
  (`router.visit`, `router.post`), non-GET `<Link method="post">`, view
  transitions, polling, infinite scroll, merge props, `WhenVisible`,
  remember (`useRemember` + remembered `useForm`), once props, history
  encryption + `clearHistory`, optimistic updates with rollback, large
  payloads. Vue and Svelte: prefetch, polling, `WhenVisible`, infinite scroll.
- Tests: `tests/browser/inertia-react-features.spec.ts`,
  `tests/browser/inertia-feature-smoke.ts` (used by `inertia-vue.spec.ts` /
  `inertia-svelte.spec.ts`).
- Example: `examples/inertia-react/src/features.ts` +
  `client/pages/Features/*`; `examples/inertia-{vue,svelte}/src/features.ts` +
  `client/pages/Features/*`.
- Remaining gaps (unchanged): automatic empty-response `back()`, previous-URL
  storage, Inertia testing helpers. Scroll management and progress indicator
  are client-owned and not separately asserted.

## INERT-007 (request headers incl. optional Precognition)

- Implemented `@Precognitive(validator, { input? })` in `@nestvexa/inertia`
  (`packages/inertia/src/precognition.ts`, `decorators.ts`, `interceptor.ts`,
  `service.ts`, `validation.ts`). Semantics checked against the v3 protocol
  page (request/response header tables) and the `laravel-precognition` 2.1.1
  client source: requests with `Precognition: true` are answered before pipes
  and the handler: `204` + `Precognition: true` + `Precognition-Success: true`
  on a pass, `422` JSON `{ message, errors }` (message arrays, Laravel
  `summarize` message) otherwise, filtered by `Precognition-Validate-Only`
  (exact, nested, `*` one segment; present-but-empty = validate nothing). All
  responses of a precognitive route carry `Vary: Precognition` (merged with
  `X-Inertia`) without changing Nest's default status. Validators: a function
  or any structural `{ validate(input) }` schema (all `@nestvexa/forms`
  adapters; no dependency added). `InertiaValidationFilter` answers
  precognitive requests with the 422 reply instead of a redirect.
- Negative/security tests: malformed Validate-Only (repeated, control chars,
  `__proto__`/`constructor`/empty segments, oversized, too many entries) → 400
  before validation; handler and pipes never run (counters); validator crash →
  500 with `Precognition: true` and no leaked message; invalid schema result →
  500; `Precognition: false` and undeclared routes run the handler.
- Tests: golden vectors `tests/fixtures/inertia/18-22-*.json` (run on Express
  and Fastify by `tests/inertia-golden.test.ts`), `tests/inertia-precognition.test.ts`
  (unit + Express + Fastify HTTP; added to `test:integration` and
  `test:security`), browser `Precognition validates touched fields…` in
  `inertia-react-features.spec.ts` (official `useForm(method, url, data)`,
  XSRF header present, 422 then 204, handler not run until submit).
- Docs: `docs/guides/inertia.md#precognition-live-validation`, parity matrix,
  `packages/inertia/README.md`, `docs/guides/react.md`. Changeset
  `.changeset/inertia-precognition.md`.
- Known limits (documented): guard rejections lack `Precognition: true`;
  multipart `validateFiles()` is not validated (FileInterceptor runs after the
  Inertia interceptor).

## INERT-012 (history encryption with the official client)

- Browser test `history encryption keeps props out of history.state and
clearHistory forces a refetch`: on an `encryptHistory: true` page the
  official client stores an `ArrayBuffer` in `history.state.page`, the secret
  does not appear in the serialized state, `historyKey` exists in
  sessionStorage; back/forward decrypts locally (no request); after a POST
  that calls `InertiaService.clearHistory()` the next page carries
  `clearHistory: true`, `historyKey` is removed, and going back refetches the
  page over XHR (a different secret is shown).
- Docs: README security note (secure context; no guarantees beyond upstream).

## INERT-013 (official-client verification)

- Covered with the official React client (each test asserts wire traffic and
  UI): view transitions (asserts `document.startViewTransition` called exactly
  once when the browser has it, zero otherwise), manual visits, instant visits
  (request held with `page.route` while the target component and shared props
  render), non-GET method links (POST bodies + XSRF), once props
  (`X-Inertia-Except-Once-Props: plans`, prop omitted, value reused), infinite
  scroll (`page=2,3` partial requests, 45 unique items), load-when-visible (no
  request until scrolled, then only `below`), polling (partial `tick`
  requests, stops), prefetching (`Purpose: prefetch` once, click served from
  cache), remembering state, optimistic updates (item visible while the POST is
  held; rollback + error on rejection).
- Vue/Svelte smoke: prefetch, polling, WhenVisible, infinite scroll.
- Not covered: scroll restoration/management and progress bar specifics.

## INERT-014 (large payloads)

- Browser test `large page payloads load fully on first visit and over XHR`:
  20 000-row props (≈2.6 MB HTML with SSR, >1.5 MB JSON XHR); the embedded page
  object parses intact (a raw `</script>` inside would break extraction),
  contains `<script>` text that renders as text, checksum and last row
  correct. Note: with SSR the official SSR server's own page script escaping
  is used (`<` and `/` escaped, `>`/`&` not); both forms are script-safe.

## SPA-003 (React)

- Not addressed: state/typed server-action hooks for React remain open (out of
  this assignment). The example now uses `@nestvexa/forms` +
  `@Precognitive` with the official `useForm`.

## SPA-006 (adapter requirements)

- Source maps: verified for every client and SSR chunk of the React, Vue and
  Svelte builds (`tests/vite-builds.test.ts`: `sourceMappingURL` comment, v3
  map, `sourcesContent`); option documented in `docs/guides/vite.md#source-maps`
  (`true`/`'hidden'`/`false`, maps only served with `sourceMaps: true`).
- Client-only (SSR off): each example has `start:csr` (`--client-only` omits
  the Inertia `ssr` option); `defineClientOnlySuite` in
  `tests/browser/inertia-feature-smoke.ts` asserts an empty root without
  server markup, client mount, XHR navigation, validation round trip and flash
  with no console errors (React 3210, Vue 3211, Svelte 3212).
- Still open: install/scaffold scripts in the CLI, per-adapter HMR/dev-mode
  browser test.

## INERT-016 (Vite for HBS/Live pages)

- Implemented `viteViewHelpers(assets, { name?, app? })` in `@nestvexa/vite`
  (`packages/vite/src/views.ts`; new dependency `@nestvexa/views` for
  `SafeHtml`): `{{viteTags "live" nonce=cspNonce}}` prints nonce meta, CSS,
  modulepreload and entry scripts. Unit tests with the real HBS engine and
  plain-object calls, negative cases (bad nonce, unknown app, extra hash
  option, missing app with several apps) in `tests/vite-manifest.test.ts`.
- Example: `examples/inertia-mixed` `/live` (HBS + Live component) with
  `vite.live.config.ts` (two entries sharing a chunk → one modulepreload).
  Browser tests in `tests/browser/inertia-mixed.spec.ts` assert every tag and
  nonce, CSS applied, scripts ran, no CSP violations, Live increments.
- Docs: `docs/guides/vite.md#server-rendered-hbslive-pages`,
  `packages/vite/README.md`. Changeset `.changeset/vite-view-helpers.md`.
- Still open: islands are bundled with esbuild, not `@nestvexa/vite`.

## INERT-018 (SSR purity, duplicates)

- `tests/vite-builds.test.ts` (added to `test:integration`): via source maps,
  no module in two chunks, no package in two versions, framework runtime and
  `@inertiajs/core` exactly once, no foreign framework; SSR bundles import no
  browser-only specifiers (`react-dom/client`, `@vue/runtime-dom`,
  `svelte/internal/client`, `@vitejs/*`, `/@vite/client`) and do not inline
  `@nestvexa/{react,vue,svelte}` `client.js`; the SSR entry renders `Home` in
  plain Node with no `window`/`document` before or after. Requires `pnpm
build` first (the test names the missing example build otherwise).

## INERT-022 (mixed host: Live route and API preservation)

- `/live` Live route added to `examples/inertia-mixed` (Live via the umbrella
  with session CSRF identity; express-session added to the example).
- Browser test asserts `/api/health` returns plain JSON from browser code on
  the Live page and from a direct request, without `X-Inertia`, and that a
  plain link from Live opens the React root with a full load.
- Note: with the default global interceptor an `X-Inertia: true` GET with a
  stale version to any route (including API routes) receives the protocol 409;
  use `interceptor: 'decorated'` to scope Inertia handling (documented
  behaviour, not changed).

## Coordinator notes

- Root `playwright.config.ts`: added webServer entries for
  `example-inertia-{react,vue,svelte} start:csr` on 3210/3211/3212 (committed).
  Specs default to the root ports; `NESTVEXA_E2E_<NAME>_URL` (REACT, VUE,
  SVELTE, MIXED, REACT_CSR, VUE_CSR, SVELTE_CSR) overrides them.
- Root `package.json`: `tests/inertia-precognition.test.ts` in
  `test:integration` and `test:security`, `tests/vite-builds.test.ts` in
  `test:integration`.
- Dependencies: `@nestvexa/vite` → `@nestvexa/views` (workspace);
  `examples/inertia-react` → `@nestvexa/forms`; `examples/inertia-mixed` →
  `express-session` + `@types/express-session`. `pnpm-lock.yaml` updated.
- Expected conflicts: `docs/guides/inertia.md` parity matrix,
  `tests/browser/inertia-framework-suite.ts`, the example `main.ts` files and
  `package.json` test script lists.

## Results

- Vitest: `tests/inertia-golden.test.ts`, `inertia-precognition.test.ts`,
  `inertia-http.test.ts`, `inertia-security.test.ts`,
  `inertia-protocol.test.ts`, `vite-manifest.test.ts`, `vite-builds.test.ts`:
  7 files, 304 tests passed.
- `pnpm lint` (ESLint + boundaries), `tsc -p tsconfig.tests.json --noEmit`,
  `pnpm docs:build`: clean.
- Playwright, Chromium + Firefox + WebKit, all eight servers at once
  (react SSR + host, vue, svelte, mixed, three CSR instances):
  161 passed, 4 failed. Two failures were the polling assertion waiting for
  an exact tick value that fast polls can skip past under load. It now compares
  numerically, and passes on Chromium and WebKit with `--repeat-each=2`. The
  other two were load timeouts: the Svelte WebKit "Stop polling" click and the
  existing mixed cross-root test on Firefox (hydration wait). Each passed when
  rerun in isolation (mixed on Firefox: 5/5). Expect timing flakes on heavily
  loaded hosts.
