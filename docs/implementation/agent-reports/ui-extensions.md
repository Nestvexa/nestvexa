# Agent report: UI kit and optional ecosystem extensions

Branch `worktree-agent-a2cc61b12b98f74d8`. Scope: ledger group EXT (section 16)
plus the related rows DX-035, DATA-020, VIEW-026 and MAINT-004. Packages touched:
`@nestvexa/ui`, `@nestvexa/observability`, `@nestvexa/core`, `@nestvexa/i18n`,
and small structural hooks in `@nestvexa/actions`, `@nestvexa/uploads`,
`@nestvexa/inertia` and `@nestvexa/live`. Example: `examples/admin-i18n`.

## EXT-017 Theme-neutral accessible components (UI kit) — implemented, small remaining gap

Implemented (server helpers in `packages/ui/src/primitives.ts`, drawer in
`packages/ui/src/helpers.ts`, behavior in `packages/ui/src/browser/index.ts`,
styles in `packages/ui/theme/theme.css`, tokens in `packages/ui/theme/tokens.css`):

- `uiDrawer` (side-anchored modal dialog reusing the dialog focus trap, Escape,
  backdrop and focus return; `side=start|end` follows text direction).
- `uiMenu`/`uiMenuItem` (APG menu button: Enter/Space/ArrowDown/ArrowUp open,
  wrap, Home/End, type-ahead, Escape returns focus, Tab and outside click close;
  link, Live action or value items with a `nv-ui-menu-select` event; disabled
  items).
- `uiPopover` (non-modal dialog disclosure: focus moves in, Escape returns,
  focus-out and outside click close).
- `uiTooltip` (APG tooltip with `aria-describedby`, hover/focus, hoverable
  bubble, Escape dismissal per WCAG 1.4.13).
- `uiBreadcrumbs`, `uiBadge` (text and live count badges: the "live
  notification badge"), `uiAlert` (role by tone, revealed dismiss button).
- `uiAccordion`/`uiAccordionItem` (APG accordion, single/multiple, arrow/Home/End
  navigation, panels readable without JavaScript).
- `uiDatePicker` (native date input, locale-formatted UTC `<output>`, strict
  ISO validation, Live model mirroring because Live models do not bind date
  inputs).
- `uiFileUpload` (native multipart input or Live `nv:upload*` directives for
  `@nestvexa/uploads`, drop zone with `accept` filtering, text-only file list
  with localized sizes, announced count). No import of uploads/client.
- `uiWizard`/`uiWizardStep` (server-driven steps, `aria-current="step"`,
  completed-step suffix and links, heading focus on in-place Live step change).
- Data table: `uiDataTable` (caption + status line), `uiTableSearch` and
  `uiTableFilter` (client-side row filtering, Live model or GET form),
  `uiSelectAll`/`uiSelectRow` (filtered select-all, indeterminate state, named
  checkboxes for native bulk forms).
- `@nestvexa/ui/tokens.css` (tokens only; kept identical to theme.css by a test),
  new `--nv-warning` token, RTL logical properties, forced-colors and
  reduced-motion rules for the new components.

Tests:

- `tests/ui-primitives.test.ts` (30 tests, real `HbsEngine`): markup contracts,
  escaping, rejected ids/hrefs/actions/accept tokens/locales/dates, structure
  rules, tokens/theme sync.
- `tests/ui-primitives-browser.test.ts` (16 tests per engine, strict CSP, zero
  CSP violations asserted): menu, accordion, popover, tooltip, drawer (LTR and
  RTL placement), date picker (en, ar-EG, model mirroring), uploader (XSS-safe
  names, drop with accept filtering), wizard focus, data table filter/select/
  FormData, alert dismissal, no-JavaScript readability, axe in light, dark,
  reduced motion and RTL. Passed in Chromium, Firefox and WebKit
  (`NV_UI_BROWSERS=chromium,firefox,webkit`). WebKit note: Playwright's WebKit
  logs a UA-stylesheet CSP message for any plain `<select>` (reproduced with a
  page containing only `<select>`); no `securitypolicyviolation` fires, so the
  test ignores that one console message for WebKit only.
- `tests/ui-helpers.test.ts` updated for the new helper names;
  `tests/ui-browser.test.ts` still passes.
- `tests/browser/admin-ui-kit.spec.ts` (4 tests) against the admin example:
  passed in Chromium, Firefox and WebKit on a local server (port 3300).

Docs: `packages/ui/README.md` (helper table, caveats, testing),
`docs/guides/ui-kit.md` section 8.

Remaining gap: no chart wrapper and no form-field wrapper helpers. Manual
screen-reader verification is still not executed (as before).

## EXT-016 16.3 Optional UI kit (heading) — EXT-017 done except chart/form-field wrappers; EXT-020 still partial.

## EXT-018 / EXT-019 — unchanged (still met): new helpers are unstyled by default, the theme and tokens are optional files, nothing global is required.

## EXT-020 Runnable examples — partially addressed

`examples/admin-i18n` gained `/admin/kit` (`views/kit.hbs`, controller routes in
`src/main.ts`, `locales/{en,ar}/kit.json`) with every new primitive, English and
Arabic, and a real native bulk-archive form (`POST /admin/kit/archive`,
CSRF-checked, at most 100 ids, owner-scoped). Tested by
`tests/browser/admin-ui-kit.spec.ts`. Remaining gap: still no SPA
(React/Vue/Svelte) adapter for the shared primitives.

## EXT-028 Starters and common search/pagination/filter primitives — partially addressed

The reusable search/filter/selection primitives now exist (`uiTableSearch`,
`uiTableFilter`, `uiSelectAll`, `uiSelectRow`, `uiDataTable`). Remaining: no
multi-tenant starter; starters are still examples, not CLI scaffolds.

## EXT-009 Render budget policy/warnings — implemented, with documented exclusions

`renderBudgetInstrumentation()` in `packages/observability/src/budget.ts`:
development-only warnings for slow Live/Inertia renders, slow actions, large
HTML, large public state (new `nestvexa.state_bytes` attribute on Live render
spans, `packages/live/src/runtime.ts`), large Inertia pages and root render
loops; deduplicated, bounded, disabled in production, a throwing sink is
ignored. Enabled in `examples/admin-i18n` (warnings observed in the e2e run).
Tests: `tests/observability-tracing.test.ts` ("render budget warnings") and the
`nestvexa.state_bytes` assertion in `tests/observability.test.ts`.
Not covered: N+1 query detection (no database integration) and island bundle
size warnings (the build/size scripts remain the tool). Documented in the
observability README.

## DX-035 OpenTelemetry spans and trace-context propagation — partially addressed

- Trace context: `packages/observability/src/trace-context.ts` (strict W3C
  `traceparent`/`tracestate` parsing, trust policy, `traceContextMiddleware`
  with AsyncLocalStorage, `formatTraceparent`), OpenTelemetry parenting through
  a structural `{ trace, context }` API in `openTelemetryInstrumentation`
  (an already active span wins), trace ids in `MemoryInstrumentation` records.
- New spans via structural hooks (no package imports): `nestvexa.action`
  (`packages/actions/src/instrumentation.ts`, `runtime.ts`, options and module
  key lists), `nestvexa.upload.receive`/`nestvexa.upload.finalize`
  (`packages/uploads/src/instrumentation.ts`, `service.ts`, `options.ts`),
  `nestvexa.inertia.render` (`packages/inertia/src/instrumentation.ts`,
  `service.ts`, `options.ts`). Attributes are ids, kinds, sizes and closed
  error codes only; tests assert inputs, results, props, file names, tokens
  and identities are absent.
- Tests: `tests/observability-tracing.test.ts` (22 tests: parsing negatives,
  trust/tracestate, ALS scoping, OTel parenting, real HTTP apps for actions,
  Inertia and uploads, invalid hook rejection). Regression: actions-http,
  actions-runtime, inertia-http, uploads-http and live tests passed (202).
- Browser side: deliberately server-side only. `@nestvexa/client` does not
  emit `traceparent` (client is at ~44.7 of 48 KiB gzip and is another area's
  budget); a browser OpenTelemetry SDK supplies the header. Documented.
- Remaining: request, guard, hydrate, client morph, asset lookup, realtime and
  SSR spans are still missing.

## EXT-030 Route-to-type generator, typed URLs — implemented; permission-aware links remain a gap

`packages/core/src/routes.ts`: `collectRoutes` / `moduleControllers` read Nest
controller metadata (including dynamic modules) without booting the app;
`generateRouteModule` emits a standalone typed `route(name, params?, query?)`
module; `buildPath` runtime builder; `@RouteName` override; path-to-regexp v8
`:param`, `*splat`, `{optional}`. Tests: `tests/core-routes.test.ts` (encoding
cannot inject segments/queries/hosts, missing/unknown/non-primitive params
rejected, duplicate names rejected, generated module executed, and a
TypeScript program proves unknown names and missing/wrong params are compile
errors). Docs: `packages/core/README.md`. Remaining: no permission-aware link
helpers, no CLI command (a documented script runs the generator), Nest
versioning not reflected. Also addresses the "route link helpers" bullet of
VIEW-026 for TypeScript callers only (no HBS helper).

## EXT-032 Plugin registry specification — implemented (minimal contract)

`packages/core/src/plugins.ts`: manifest validation (`parsePluginManifest`),
`definePlugin`, `PluginRegistry` (explicit object installs only; strings, URLs
and names are refused; duplicate, incompatible-range and post-seal installs
rejected; failed setup does not register), `satisfiesVersion` semver subset
with prerelease precedence, closed `PLUGIN_CAPABILITIES`. Tests:
`tests/core-plugins.test.ts` (includes accessor/inherited manifests and
remote-name rejection). Docs: `packages/core/README.md`. Remaining: no
portable component package format; existing packages are not yet registered
through the registry (relevant to MAINT-004, which stays partial).

## DATA-020 i18n server-to-client hydration — implemented

`I18n.hydration()` / `I18n.hydrationScript()` (`packages/i18n/src/i18n.ts`) and
the new `@nestvexa/i18n/client` entry (`packages/i18n/src/client.ts`:
`parseLocaleHydration`, `readLocaleHydration`, `createClientI18n`). Fails closed
(explicit selection, size caps), fallback locales recorded for plural rules,
script-safe JSON. A boundary rule in `scripts/boundaries.mjs` keeps the client
free of Node/Nest/views imports. Tests: `tests/i18n-hydration.test.ts`
(client output equals server output for Arabic plurals; hostile catalog text
cannot close the script; tampered payloads rejected). Docs: i18n README and
guide. Not wired into the admin example (no client bundle there).

## EXT-029 Email/notification template bridges — not implemented (gap)

Not done. Documented in the i18n README caveats; a provider-neutral bridge
(render subject/html/text through the view engine, send with the host's Nest
mail integration) remains open.

## EXT-001 / EXT-002 / EXT-003 (headings)

EXT-002's missing items: plugin registry, typed routes and render budgets now
exist; email bridges and the offline queue (EXT-014) remain. EXT-003: EXT-009
addressed; EXT-004, EXT-006, EXT-007 and EXT-010 were not in this assignment and
are unchanged.

## Not touched

EXT-004, EXT-006, EXT-007, EXT-008, EXT-010, EXT-014, EXT-027, AI/flags/offline/
cache packages.

## Commands run (all passing at the end)

- `pnpm exec vitest run tests/ui-primitives.test.ts tests/ui-helpers.test.ts tests/ui-browser.test.ts tests/ui-primitives-browser.test.ts`
- `NV_UI_BROWSERS=firefox,webkit pnpm exec vitest run tests/ui-primitives-browser.test.ts`
- `pnpm exec vitest run tests/observability.test.ts tests/observability-tracing.test.ts`
- `pnpm exec vitest run tests/actions-http.test.ts tests/actions-runtime.test.ts tests/inertia-http.test.ts tests/uploads-http.test.ts tests/live.test.ts`
- `pnpm exec vitest run tests/core.test.ts tests/core-routes.test.ts tests/core-plugins.test.ts`
- `pnpm exec vitest run tests/i18n-hydration.test.ts tests/i18n-hbs.test.ts tests/i18n-security.test.ts`
- `pnpm exec playwright test -c playwright.local.config.ts admin-ui-kit.spec.ts` (chromium, firefox, webkit; local server on port 3300) and a local copy of `admin-i18n.spec.ts` on port 3300 (chromium, 11 passed)
- `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`, `pnpm size:check`, `node scripts/docs.mjs`

## Merge notes for the coordinator

- New test files were added to root `package.json` scripts: `test:unit`
  (`tests/core-routes.test.ts`, `tests/core-plugins.test.ts`,
  `tests/ui-primitives.test.ts`, `tests/i18n-hydration.test.ts`,
  `tests/observability-tracing.test.ts` next to `tests/observability.test.ts`)
  and next to `tests/ui-browser.test.ts` (`tests/ui-primitives-browser.test.ts`).
  Expect textual conflicts on those long script lines.
- `tests/browser/admin-ui-kit.spec.ts` uses the existing admin-i18n web server
  (port 3110) of the root `playwright.config.ts`; no new webServer entry needed.
- `examples/admin-i18n` now depends on `@nestvexa/observability` (lockfile
  importer change).
- Small hunks in other areas' packages: `packages/live/src/runtime.ts` (one
  attribute), `packages/actions/src/{options,module,runtime,index}.ts`,
  `packages/uploads/src/{options,service,index}.ts`,
  `packages/inertia/src/{options,service,index}.ts`, `scripts/boundaries.mjs`.
