# Gaps round 6 (branch `r6-gaps6`)

Closes the gaps named by the ledger re-audit for INERT-002 (and so its share
of INERT-001), FORM-012, EXT-005, DOC-017, DOC-034 and DOC-035. Every claim
below names the test that proves it; anything not run is said so.

## INERT-002 (INERT-001 depends on it)

### `shareOnce()`

Semantics taken from the reference adapter: the Inertia docs "Sharing once
props" section (`Inertia::shareOnce(key, fn)`, chainable `as()`/`until()`/
`fresh()`, and the middleware `shareOnce(Request)` hook whose results "the
middleware will evaluate both `share()` and `shareOnce()`, merging the
results"), and inertia-laravel 2.x `Middleware::handle`, which shares
`shareOnce()` entries key by key after the `share()` array (once props win on
conflict; `OnceProp` values are shared as is, anything else goes through
`Inertia::shareOnce`, which requires a callable).

- Module option `shareOnce: (request) => ({ key: callback | once(...) })`
  (`packages/inertia/src/options.ts`, `onceShared()`): callbacks are wrapped
  in `once()`, existing `once()` props are kept, any other value (plain value,
  `null`, another prop type such as `defer()`) is an `InertiaConfigurationError`
  (500). Built in a null-prototype map; a `__proto__` key is rejected by the
  resolver and cannot reach `Object.prototype`.
- `InertiaService.shareOnce(request, key, callback | OnceProp, options?)`
  (`packages/inertia/src/service.ts`): request-scoped, for guards, interceptors
  and middleware. `options` (`as`, `until`, `fresh`) replace the reference
  adapter's chaining because props here are immutable (documented deviation).
- Precedence: `share` < `shareOnce` < request-scoped `share()`/`shareOnce()` <
  page props. Once-shared keys appear in `sharedProps`.
- Tests: `tests/inertia-share-once.test.ts` (Express and Fastify, 17 tests):
  first visit resolves and emits `onceProps` (with `as` keys and `until`
  expiry from the fake clock) and `sharedProps`; with
  `X-Inertia-Except-Once-Props` the callbacks are never called (call
  counters) while `onceProps` metadata stays; full visits always resolve;
  precedence both ways; an existing `once()` prop with `fresh` overrides the
  client's except-once; negative cases (non-callback value per request 500
  without echoing it, plain value, `defer()`, `null`, `__proto__`, non-function
  option at `forRoot`).
- Browser: `tests/browser/inertia.spec.ts` "keeps a once-shared prop on the
  client and skips it on later visits" against `examples/inertia-basic`
  (official `@inertiajs/react` 3.10.0): the client sends
  `X-Inertia-Except-Once-Props: regions` on the next visit, the JSON page has
  no `regions` prop but `onceProps.regions`, and the page still shows the first
  value.

### Error pages

Reference behaviour: the Inertia "Error handling" docs render
`Inertia::render('ErrorPage', ['status' => $status])` with the original status
for 500, 503, 404 and 403 outside `local`/`testing`; in development the
framework's own error output is shown.

- `errorPage: { component, statuses?, debug?, app?, props? }` module option and
  `InertiaErrorPageFilter` (`packages/inertia/src/error-page.ts`), registered as
  `APP_FILTER` by `forRoot` when `errorPage` is set (`errorPageFilter`
  behaviour flag; `forRootAsync` needs `errorPageFilter: true`). Exported:
  `InertiaErrorPageFilter`, `errorPageStatus`, `DEFAULT_ERROR_PAGE_STATUSES`,
  `InertiaErrorPageOptions`, `InertiaErrorPageContext`,
  `InertiaShareOnceResolver`.
- Full visits (Accept has `text/html`) get the HTML document, Inertia visits a
  JSON page, both with the original status, so the official client swaps in
  the component instead of its error modal.
- Dev/prod difference: `debug` defaults to `NODE_ENV === 'development'`.
  Production props are `{ status, message }` with a fixed status text; debug
  adds the exception's own message and `exception: { name, message, stack }`.
- Left to Nest's `BaseExceptionFilter`: statuses outside the list, JSON API
  clients, Precognition requests, responses already sent, and no `errorPage`.
  `InertiaValidationException` is delegated to `InertiaValidationFilter`, so
  filter selection order cannot break the validation redirect. Rendering
  failures (for example a throwing `share`) answer a plain-text status line.
  Non-`HttpException` errors are logged. HTTP only (rethrows elsewhere).
- Tests: `tests/inertia-error-page.test.ts` (Express and Fastify, 29 tests):
  unknown route as an HTML document (404); Inertia visit JSON page (403,
  `X-Inertia`, `Vary`); no message, stack, secret or file path in production
  500/503 pages; message and stack only in debug; hostile exception text
  (`</script><script>`, U+2028) escaped in the document; 400 left to Nest;
  JSON clients get the default JSON (including `Internal server error` for a
  500); validation still redirects back; Precognition untouched; `debug` off
  under `NODE_ENV=test`; custom statuses and `props` hook; plain-text fallback
  when `share` throws; not registered without the option; `forRootAsync`
  opt-in; six configuration errors.
- Browser: `tests/browser/inertia.spec.ts` "renders the configured error page
  for 404, 403 and 500 without exception details" against `inertia-basic`:
  404 full visit renders `ErrorPage` (shared props intact), `<Link>` visits to
  `/admin` (403) and `/broken` (500) render it in the same document with the
  original statuses, no exception text or stack in the DOM, no modal, no page
  errors.
- Example: `examples/inertia-basic` gained `shareOnce`, `errorPage`, `/admin`,
  `/broken` and an `ErrorPage` component (README updated).
- Docs: `packages/inertia/README.md` (options, `shareOnce`, "Error pages",
  status), `docs/guides/inertia.md` ("Once-shared props", "Error pages", parity
  rows moved from Not implemented to Server / Server + Client), changeset
  `.changeset/inertia-share-once-error-pages.md` (minor).
- Remaining for INERT-002: none of the two audited gaps. The heading row
  INERT-001 still depends on its other children (the ledger lists INERT-007,
  -012, -013, -014, -016, -018, -022, SPA-003, SPA-006), which this round did
  not touch.

## FORM-012

- `tests/forms-view-engines.test.ts` (12 tests) renders one form, built from
  `defineForm().view()`, `errorSummary()` and a nested `fieldView()` with a
  hint, through `HbsEngine`, `EjsEngine`, `PugEngine` and `NunjucksEngine`
  with hostile messages, labels and values (`"><script>…<img onerror>`,
  `&`, quotes, `<`). It asserts that EJS, Pug and Nunjucks tokenize to the same
  elements, decoded attributes and text as Handlebars, that no element or
  attribute exists beyond those the template wrote, and the ARIA wiring: ids,
  `aria-invalid`, `aria-describedby` (absent on valid fields, hint id first on
  nested paths), error ids, summary `href="#…"` links, first message only,
  form-level messages first.
- Findings: no escaping or attribute bug in any adapter. The only engine
  difference is Pug writing `aria-describedby=""` for an empty string, which
  the docs now cover (`|| undefined`). No source change was needed.
- Docs: `packages/forms/README.md` "Status and limits" now says Implemented
  (with the escaping rule), `docs/guides/forms.md` shows the EJS, Pug and
  Nunjucks forms of the accessible control; changeset
  `.changeset/forms-view-engines.md` (patch).

## EXT-005

- `tests/browser/islands-deferral.spec.ts` against `examples/hybrid-dashboard`
  (no example change), asserting on network requests for each island's
  manifest entry chunk:
  - `visible` (`activity-feed`, Vue): with a 360 px viewport the island is
    below the fold, its state is `scheduled` and `vue-feed-*.js` has not been
    requested after the immediate islands mounted; scrolling requests it once
    and the island mounts.
  - `idle` (`status-widget`, Svelte): an init-script stub holds the loader's
    `requestIdleCallback` (the call registered with `timeout: 2000`, which the
    test asserts); `svelte-widget-*.js` is not requested until the held
    callback runs, then it loads and mounts.
  - `idle` without `requestIdleCallback` (Safari path): with Playwright's
    clock paused before load, nothing is requested after 150 ms of fake time;
    the chunk is requested once the 200 ms fallback timer is reached.
- Docs: `packages/islands/README.md` (strategy timings and the spec),
  `docs/guides/islands.md` (test command).

## DOC-017

- `README.md` "Runnable examples" now lists directive-lab (3360),
  islands-vite (3479), browser-lab (3860), client-chunks (3880),
  api-coexistence (3885) and distributed-live (3220, Redis via `REDIS_PORT`).
  showcase and uploads were already listed.
- New check in `apps/docs/src/build.mjs` (run by `scripts/docs.mjs` /
  `pnpm docs:build`): every `examples/<dir>/package.json` name must appear in
  the README's "## Runnable examples" section (text outside the section does
  not count); a README without the section fails when examples exist.
- Tests: `tests/docs-site.test.ts` adds "rejects a workspace example missing
  from the README example list" and "rejects examples without a README example
  list"; the real repository passes (`node scripts/docs.mjs --check-only`:
  249 documents, 46 provenance snippets).

## DOC-034

- `docs/contributing/test-matrix.md`: describes the four workflows (ci,
  services, nightly, security/release), adds `test:property`, `test:mutation`
  and `pnpm load` rows with where they run, the services row now covers the
  four-replica Redis browser suite, drops the stale "28 tarballs", and the
  Known gap keeps only what is still true (mutation not gating, advisory load
  latency, dev proxy instead of a load balancer, Docker not booted, no manual
  AT review, external links unchecked, Node 26/macOS untested).
- `docs/testing/guide.md`: a worked example of testing a custom guard on an
  `@Action()` method (two provenance-checked snippets from
  `tests/live-pipeline.test.ts`), the suites table gains `test:property`,
  `test:mutation`, `load` and the multi-replica services suite, a paragraph
  maps suites to workflows, and the Known gap no longer says load, fuzz and
  mutation testing were never run.

## DOC-035

- `docs/deployment/README.md`: the Known gap block is replaced by what has
  been run (services.yml multi-replica Redis browser suite, nightly load/fuzz,
  CI Docker build) and what is still open (no production load balancer, no
  real AWS S3, no CDN, Compose stack not booted in CI, independent security
  review).
- `docs/deployment/docker.md`: corrected Known gap, a new "CI" section stating
  exactly what the job proves and does not, and a fix to the stale claim that
  Redis cannot share Live state (it can, with `RedisLiveStore`).
- `docs/deployment/node-process-managers.md`: the "RealtimeService shutdown
  path has no test" sentence was stale; it now cites the existing
  `tests/realtime-hub.test.ts` shutdown assertions.
- CI: new `docker` job in `.github/workflows/ci.yml`: `docker compose ... config
--quiet`, `docker build --file examples/showcase/Dockerfile .` (no push),
  and `docker image inspect` checks for the `node` user and the `/api/health`
  health check. **Not run here** (no Docker locally). As a proxy, the
  Dockerfile's two build steps (`pnpm install --frozen-lockfile --filter
"@nestvexa/example-showcase..."` and the filtered build) were run on a clean
  `git archive HEAD` export on this Windows host and succeeded; the first CI
  run on Linux is the real evidence. The YAML parses (yaml 2.9.1).

## Not done

- The Docker job has not executed in GitHub Actions yet; the container is not
  started and the Compose stack is not booted in CI (by assignment: build only).
- INERT-001 stays open on its other child rows.
