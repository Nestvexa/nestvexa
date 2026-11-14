# Views, directives and doc drift (round 5)

Branch `r5-views5` from main `928b2f1`. Ports 4100–4119 (the example uses 4100).
No Docker.

## Ledger rows

### VIEW-006 (namespaces), VIEW-018 (permission helpers), VIEW-021 (error pages), VIEW-026 (themes, namespaces), VIEW-019 (runnable example)

The `@nestvexa/views` features already existed (round 4). This round wires them
through the umbrella and adds a runnable example with browser tests.

- **Core config:** `views.namespaces` and `views.themes` (name -> directory maps)
  in `NestvexaOptions`. Names match `/^[a-z][a-z0-9-]{0,63}$/` (not
  `constructor`/`prototype`), at most 64 entries, non-empty NUL-free directory
  strings, data properties only (accessors are not read). They become frozen
  null-prototype copies and are present in the normalized config only when
  configured, so existing shapes don't change. They have no environment
  variables. Code: `packages/core/src/config.ts`. Tests: `tests/core-config.test.ts`
  ("views.namespaces and views.themes", 14 cases).
- **Umbrella** (`packages/nestvexa/src/mvc.module.ts`):
  - The HBS engine receives `namespaces`/`themes`.
  - On Express, `@Render('admin::page')` now works. When namespaces are
    configured, an Express `view` class hands `ns::` names to the engine, and
    other names keep Express's own `View`. Fastify already dispatched through
    `reply.view`.
  - `configureNestvexa(app, { errorPages })` is the opt-in that installs
    `ViewErrorPageFilter`, with `render` bound to the umbrella engine.
    - Options are `views`, `development`, `html` and `log`.
    - A caller-supplied `render` is rejected.
    - Options are accepted on the first call only; a later call with different
      options rejects.
    - Without `errorPages`, nothing is installed.
  - New exported types: `ConfigureNestvexaOptions`, `NestvexaErrorPageOptions`.
- **Tests:** `tests/umbrella-views.test.ts` (13 tests, Express and Fastify):
  - namespaced `@Render` and the vendor override
  - theme override and fallback; an unknown theme gives a 500 with no path echo
  - `permissionHelpers` (fail closed on a throwing policy) and `grantPermissions`
  - 404/500 views, the router 404, JSON for API clients, no 5xx detail leak
  - the development page with template `broken.hbs` and line 2
  - no filter without the option; late and invalid options rejected
- **Example:** `examples/views-tour` (new, port 4100). It covers:
  - `admin::dashboard`, plus the `views/vendor/admin/settings.hbs` override
  - the `dark` theme overriding `layout.hbs`
  - `/posts?role=` (`permissionHelpers`) and `/posts/granted` (`grantPermissions`)
  - 404/5xx error views via `configureNestvexa`
  - a Live panel with `nv:cloak` and `nv:class`
  - a lazy visible feed
- **Browser tests:** `tests/browser/views-tour.spec.ts`, 8 tests, one per
  feature, with CSP violation capture and axe checks.
- **Docs:**
  - `docs/guides/template-engines.md` ("Through the `nestvexa` umbrella", error-page umbrella section)
  - `docs/reference/configuration.md`
  - `packages/nestvexa/README.md`, `packages/core/README.md`
  - `examples/views-tour/README.md`
- **Remaining gaps:**
  - Themes are per render (`engine.render(view, model, { theme })`). `@Render` has no theme channel, and Live component views render without a theme.
  - VIEW-008 (HBS line info) and VIEW-010 (asset manifest) were not in scope; their existing state is unchanged.

### DIR-022 `nv:cloak`

- The views tour ships `[nv\:cloak]{display:none!important}` in its stylesheet and cloaks the interactive Live panel.
- Browser tests (`views-tour.spec.ts`, "nv:cloak"):
  - **Runtime start:** the boot module (`/_nestvexa/boot.js`) is held by a route. While it is pending, the cloaked element is attached, still carries `nv:cloak` and computes `display: none`, even after 300 ms. Once released, the element becomes visible, the attribute is removed, and no CSP violations are reported.
  - **Runtime failure:** the boot module is aborted, so the runtime never starts. The content stays hidden and the attribute stays.
- No client change was needed; removal happens only after a successful binding pass, as before.
- Docs: directive-matrix row updated.
- Remaining: reinitialization after a failed init is not exercised beyond these two cases.

### DIR-025 `nv:bind` property/class binding

- **New directive** `nv:class="token:field ..."` (`packages/client/src/bindings.ts`):
  - It takes 1–16 unique simple class tokens (`/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/`), each with a field or dotted path whose value must be a boolean.
  - It applies `classList.toggle` only to those tokens, so server classes stay.
  - It never writes `style`.
  - Every value is validated before any DOM change, as for the other bindings.
- **Conflict checks:**
  - `nv:loading.class` on the same token is rejected (`loading.ts`).
  - `nv:offline.class`, `nv:current` and transition stage classes on the same token are rejected (`presentation.ts`).
  - `nv:ignore.self` wrappers reject `nv:class` (`morph.ts`).
  - Element signatures include `nv:class`.
  - The parser is registered in `protocol.ts`.
- **Why no arbitrary property or style binding** (`docs/reference/directives.md`):
  - Arbitrary properties (`innerHTML`, `srcdoc`, `on*`, `value`/`checked`) are script or ownership sinks; `value` and `checked` belong to `nv:model`.
  - Inline style is blocked by a strict `style-src` and can carry `url()` requests or overlays.
  - The safe reflected properties (`disabled`, `readonly`, ARIA) stay attribute-bound.
- **Tests:**
  - `tests/client-bindings.test.ts`: parse, reject cases, no single-value evaluation, `nv:bind` still rejects `style`/`class`/`innerHTML`/`value`.
  - `tests/client-bindings-dom.test.ts`, 4 new Chromium cases: toggling beside server classes, atomic validation with cloak retained, ownership boundaries, loading/offline/current conflicts. The fixture now also loads `loading.js` and `presentation.js`.
  - `tests/browser/views-tour.spec.ts` ("nv:class") in all three browsers.
- **Size:** `pnpm size:check` gives 48,040 gzip bytes (budget 49,152; main 47,715, so +325).
- **Docs:** `docs/reference/directives.md`, `docs/reference/directive-matrix.md`, `packages/client/README.md`, `.changeset/client-nv-class.md`.

### BROW-015 lazy hydration (`visible`)

- `examples/views-tour` `/lazy` mounts `TourFeed` (`lazy: 'visible'`) below a 2400 px spacer. Its placeholder is `role="status" aria-busy="true"`.
- Browser test (`views-tour.spec.ts`, "lazy Live component with the visible strategy"):
  - **Before scrolling:** the root carries `data-nv-lazy="visible"`, the runtime has registered it (`aria-busy="false"`), and no POST to `/tour-feed/` is sent in 600 ms. The element is below the viewport, and axe reports no violations.
  - **After scrolling in:** exactly one request, `/_nestvexa/live/tour-feed/_sync`. The content renders, the placeholder is gone, and `data-nv-lazy` is removed.
  - **Re-entry:** scrolling away and back sends no second request.
  - Axe passes on the loaded region, and no CSP violations are reported.
- Docs: `docs/guides/nested-components.md` ("Lazy components" evidence paragraph).
- Remaining: deferred islands, `load` timing UX and placeholders for islands are not covered here.

### BROW-013 teleports

- **Decision:** teleports are out of scope for 1.0, recorded in an ADR amendment, not implemented.
- **Where:** `docs/adr/0004-renderers-and-islands.md`, "Amendment (2026-11-14): Live teleports are out of scope for 1.0".
- **Rationale:** one owner per node and descendant ownership walks; delegated events and form association; split-fragment morph identity and rollback; accessibility rules that differ per widget; and a client budget under active chunk splitting.
- **Supported alternatives:** native `<dialog>`/`popover` (top layer without moving nodes), CSS positioning, or Alpine `x-teleport` or an island inside `nv:ignore`.
- **Revisiting:** a future teleport needs its own ADR, with an owner registry, event/form association, split morphing, teardown and browser tests.
- The other BROW-013 outstanding issues are unchanged.

## Doc drift fixed

- **ADR status lines:**
  - ADRs 0002, 0004, 0005, 0009 and 0010 now match their own status updates.
  - New status update in 0002 and 0005 (2026-11-14): replay and locks are verified on real Redis (`tests/services/distributed.spec.ts`, `scripts/services-check.mjs` `redis-live-coordination`), including the lapsed-lease fault test.
  - In 0009, the obsolete "tests remain unrun" acceptance text is marked superseded.
- **`docs/architecture/overview.md`:** replay and locks now run on real Redis. Plugins are described as a deprecated adapter over the single extension model. The same fix is in the `packages/core/README.md` limits.
- **ADR 0007:** amendment covering the CycloneDX SBOM (`scripts/sbom.mjs`, checked by `release-check`), provenance (`release.yml`, `release-publish.mjs`, `npm publish --provenance` via OIDC trusted publishing) and `pnpm audit:licenses` (CI and security workflows, `tests/supply-chain-scripts.test.ts`).
- **`THIRD_PARTY_NOTICES.md`:** the root and `packages/nestvexa` copies are kept identical. The served browser code was rechecked for 2026-11-14 and is unchanged (`@alpinejs/csp` 3.17.5, bundled Vue 3.5.41). Added the published runtime dependency licenses and the SBOM/license audit pointers.
- **`docs/architecture/upstream-compatibility.md`:**
  - New 2026-11-14 registry snapshot (real `npm view` results; nothing upgraded); the 2026-11-05 table is kept as historical.
  - The stale Inertia "not claimed" sentence (Vue/Svelte clients, Precognition, SSR) is marked superseded.
- **`packages/client/README.md`:** `$live.state` and `$live.entangle`, and `nv:class`.

## Test commands run (one file / one browser at a time)

- `pnpm exec vitest run tests/client-bindings.test.ts`: 40 passed
- `pnpm exec vitest run tests/client-bindings-dom.test.ts`: 13 passed
- `pnpm exec vitest run tests/client-directive-grammar.test.ts`: 195 passed
- `pnpm exec vitest run tests/umbrella-views.test.ts`: 13 passed
- `pnpm exec vitest run tests/core-config.test.ts`: 25 passed
- `pnpm exec vitest run tests/client-loading.test.ts`: 46 passed. First run: timeouts, because the fixture did not serve `bindings.js`, which `loading.js` now imports. The fixture was fixed in `e30f198`.
- `pnpm exec vitest run tests/client-presentation.test.ts`: 44 passed (same fixture fix).
- `pnpm exec vitest run tests/umbrella-live.test.ts`: 45 passed.
- `pnpm exec vitest run tests/docs-site.test.ts`: 18 passed.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `pnpm lint` (eslint and boundaries): exit 0.
- `pnpm size:check`: 48,040 / 49,152 on this branch.
- `pnpm exec playwright test -c playwright.local.config.ts views-tour`: 8/8 each in chromium, firefox and webkit.
- **Throwaway local merge with current main** (`1131243`, which includes the client chunk split, ADR 0036):
  - Client sources merge cleanly.
  - The Live core `index.js` is 39,638 gzip, against 39,306 on main (+332; budget 45,056). All Live code is 54,890 / 61,440.
  - `tests/client-bindings.test.ts` and `tests/client-bindings-dom.test.ts` pass on the merged tree (53/53).
  - The merged-tree browser run was not completed: main's `pnpm-lock.yaml` lacks the `examples/auth-passport` importer, so a frozen install fails on main itself.

## Merge notes

- Root `playwright.config.ts`: new webServer `@nestvexa/example-views-tour` on `http://127.0.0.1:4100/api/health`.
- `package.json`: `tests/umbrella-views.test.ts` added to `test:integration`.
- `pnpm-lock.yaml`: new importer `examples/views-tour`, no new packages.
- Conflicts against main `1131243` (checked with `git merge-tree`):
  - `package.json`: test-group lists; use the union script.
  - `packages/client/README.md`: keep main's chunk paragraph and this branch's directive and `$live` sentence.
  - Everything else, including `packages/client/src`, `pnpm-lock.yaml` and `playwright.config.ts`, auto-merges.
- After merging, regenerate the lockfile with `pnpm install`, because main's lockfile is already missing `examples/auth-passport`.
- After merging, re-run `pnpm size:check` and `tests/browser/views-tour.spec.ts`.
