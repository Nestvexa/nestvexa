# Agent report: UI kit chart and form-field wrappers (round 4)

Branch `r4-ext-ui-chart-fields`. Scope: ledger row EXT-017 (spec section 16.3),
the two components its `outstandingIssues` still list after round 2: **chart
wrapper** and **form-field wrappers**. Package touched: `@nestvexa/ui` only
(plus one line in `scripts/boundaries.mjs`). No new dependencies, no root
`package.json` or Playwright changes.

## EXT-017 Form-field wrappers — implemented

Built like the existing components: markup contract → HBS helper → React,
Vue and Svelte wrappers → theme CSS (no browser behavior needed).

- Contract: `packages/ui/src/fields.ts` (`textFieldMarkup`,
  `textareaFieldMarkup`, `selectFieldMarkup`, `checkboxFieldMarkup`,
  `radioGroupFieldMarkup`), re-exported from `@nestvexa/ui/markup`.
- HBS helpers: `uiTextField`, `uiTextareaField`, `uiSelectField`,
  `uiCheckboxField`, `uiRadioGroupField` (`packages/ui/src/helpers.ts`).
- Wiring: `<label for>` ↔ control `id`; hint `{id}-hint`; error
  `{id}-error` (`role="alert"`, one `<p>` per message, rendered only while
  invalid); `aria-describedby` = extra `describedBy` + hint + error;
  `aria-invalid="true"` while invalid; `required` + `aria-required="true"` and
  an `aria-hidden` asterisk. Radio groups are `<fieldset role="radiogroup">`
  with a `<legend>`, describedby/required on the group, `aria-invalid` on each
  radio; the first radio carries the field id (`{id}-2`, `{id}-3`… for the
  rest) so forms error-summary links and Live focus-first-invalid land on it.
- `@nestvexa/forms` compatibility: `field=` accepts a `fieldView()` result
  (read structurally, no import); its `id`, `errorId` and `messages` are used,
  `id` mismatches are rejected, `field` and `error` are mutually exclusive.
  Tested with real `fieldView`/`errorSummary` from `packages/forms/dist`.
- Live: `model="a.b"` emits `nv:model="a.b"`, `modelModifiers` is a closed
  vocabulary (`live.debounce.300ms`, `blur`, …); names accept identifiers,
  dotted and bracket paths; prototype keys rejected. Framework wrappers drop
  `nv:` attributes.
- Ids are validated closed-grammar identifiers, so they are deterministic and
  need no escaping; every text value is escaped.
- Wrappers: `TextField`, `TextareaField`, `SelectField`, `CheckboxField`,
  `RadioGroupField` in `src/adapters/react.ts`, `src/adapters/vue.ts` and
  `svelte/*.svelte` (uncontrolled; `defaultValue`/`defaultChecked` read once;
  `onChange` / Vue `change` / Svelte `onchange`). React maps a textarea's text
  to `defaultValue`; Svelte `Markup.svelte` sets it as `value` (children would
  print hydration markers inside the textarea, found by the parity test).
- Theme: `.nv-field*` styles in `theme/theme.css` (focus rings, 2.5rem
  targets, invalid border, forced-colors).

## EXT-017 Chart wrapper — implemented

- Contract: `packages/ui/src/chart.ts` (`chartMarkup`, `chartTypes`); helper
  `uiChart` (inline, or a block only with `type="custom"`).
- Output: `<figure data-nv-ui-chart>` with `<figcaption id="{id}-title">`,
  optional `{id}-desc`, `<svg role="img" aria-labelledby aria-describedby>`
  for `bar`, `line`, `sparkline`, and a data table `{id}-data` (caption,
  `th scope`, `data-value` per cell, `Intl.NumberFormat(locale)` text) that is
  always present, visually hidden unless `showTable`. Legend (`aria-hidden`)
  for 2+ series.
- CSP-safe: no `<script>`, `style=` or `on*=`; geometry attributes only,
  colors and dash patterns via classes and the new `--nv-chart-1…8` tokens
  (light/dark in `theme.css` and `tokens.css`); forced-colors fallback.
- Validation: 1–200 labels, 1–8 series (sparkline 1), one value per label,
  finite numbers within ±1e15 (`NaN`, `Infinity`, strings, `null` rejected),
  `min`/`max` must contain the data, BCP 47 `locale`. Geometry rounded to
  0.01 so all renderers print identical strings.
- Third-party charts: `type="custom"` renders a `role="img"` container
  `{id}-canvas` around the block body / React children / Vue default slot /
  Svelte `children`, plus the same table. `chartData(element)` in
  `@nestvexa/ui/browser` (re-exported by the wrappers) reads the table back
  into `{ labels, series }` (returns `undefined` for malformed or non-finite
  data), so a library can be fed from an external script.
- Svelte: `SvgMarkup.svelte` (`<svelte:options namespace="svg">`) renders SVG
  children so client-created (non-hydrated) charts are real SVG elements.
- Refactor: the element tree moved from `markup.ts` to `src/tree.ts` and
  `localeTag` to `html.ts` (shared by `markup.ts`, `fields.ts`, `chart.ts`);
  `scripts/boundaries.mjs` applies the "no Node / @nestvexa imports" rule to
  the three new browser-safe files.

## Tests (all run, chromium)

| Command                                                                                                                          | Result                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm exec vitest run tests/ui-helpers.test.ts tests/ui-primitives.test.ts`                                                      | 76 passed                                                                |
| `pnpm exec vitest run tests/ui-primitives-browser.test.ts`                                                                       | 22 passed                                                                |
| `pnpm exec vitest run tests/ui-adapters.test.ts`                                                                                 | 34 passed                                                                |
| `NV_UI_BROWSERS=firefox,webkit pnpm exec vitest run tests/ui-primitives-browser.test.ts tests/ui-adapters.test.ts`               | 85 passed, 24 failed — all timeouts on a heavily loaded host (see below) |
| `NV_UI_BROWSERS=webkit pnpm exec vitest run tests/ui-adapters.test.ts -t "wires form fields\|renders charts\|markup of the HBS"` | 4 passed, 3 failed — `locator.click` actionability timeouts              |

Cross-browser status, honestly: under the machine load at the time (several
other agents running builds, Stryker and Playwright), the firefox/webkit run
had 24 failures, every one a timeout (`Test timed out`, `locator.click:
Timeout 30000ms`, "waiting for element to be visible, enabled and stable"),
none an assertion. Pre-existing tests failed the same way (menu, accordion,
popover, drawer in `ui-primitives-browser`; dialog, toasts, remount in
`ui-adapters`). What did pass outside Chromium: all six new field/chart tests
in `ui-primitives-browser` (axe, CSP, `chartData`, colors) in **Firefox and
WebKit**; SSR parity (fields and charts included) in **Firefox and WebKit**;
the new field and chart adapter tests for **React, Vue and Svelte in
Firefox**. In WebKit the new adapter tests passed for some frameworks and
timed out for others in a click on a static label or the `#toggle` button.
The coordinator should rerun
`NV_UI_BROWSERS=webkit pnpm exec vitest run tests/ui-adapters.test.ts` on
an idle machine before treating WebKit adapter behavior as proven.

- `tests/ui-helpers.test.ts`: field wiring, forms `fieldView` ids/messages,
  `nv:model` modifiers, escaping of labels/hints/errors/values, textarea,
  select, checkbox, radio group, rejected names/models/options.
- `tests/ui-primitives.test.ts`: chart markup (bar/line/sparkline/custom),
  deterministic geometry, CSP-safety regex, escaping of every label/title/series
  name, non-finite/non-numeric/out-of-bound rejection, block body only for
  `custom`.
- `tests/ui-primitives-browser.test.ts` (real browser, strict CSP
  `default-src 'self'; style-src 'self'`, zero `securitypolicyviolation`
  asserted after each test): accessible names/descriptions/invalid/required,
  label focus, native radio keyboard, posted FormData; chart image name and
  description, table rows, hidden vs shown table, theme colors light/dark,
  third-party canvas drawn from `chartData` by an external script, malformed
  table → `undefined`; axe WCAG 2.1 A/AA for fields and charts in light and
  dark mode.
- `tests/ui-adapters.test.ts`: React/Vue/Svelte SSR canonically equal to the
  HBS helpers for all five fields and four charts; hydration without
  mismatches under strict CSP; full-page axe; field edits reported through
  each framework's callback and posted values; charts stay SVG-namespaced after
  a client-side remount; XSS/attribute-injection and non-finite negative tests
  through the framework-facing builders.

Also run, all passing: `pnpm --filter "@nestvexa/ui..." build`, `pnpm lint`
(incl. boundaries), `pnpm format:check`, `pnpm build` +
`pnpm exec tsc -p tsconfig.tests.json --noEmit`, `pnpm docs:build`.
`pnpm size:check` not needed (the client package is unchanged).

## Docs

`packages/ui/README.md` (helper table, fields/charts usage, `chartData`,
wrapper table, security, caveats, testing), `docs/guides/ui-kit.md` (new
section 10 "Form fields and charts", placed after section 9 so the
`#9-react-vue-and-svelte-pages` anchors in the React/Vue/Svelte guides stay
valid; wrapped set, limits),
`.changeset/ui-chart-form-field.md` (minor).

## Commits

- `647c20e` feat(ui): form-field wrappers and a CSP-safe chart helper
- `3e6ea78` feat(ui): React, Vue and Svelte field and chart components
- `4c47552` docs(ui): document form fields and charts
- `73c8826` fix(ui): reuse the shared nvUi window type and keep the guide's
  section 9 anchor
- this report

## Remaining gaps

- WebKit run of the adapter behavior tests not yet green on an idle machine
  (load timeouts only; see Tests).

- Charts: bar, line and sparkline only, min/max(/zero) ticks, no tooltips or
  mixed bar+line; anything else via `type="custom"`.
- Fields: no multi-select, checkbox-group, file or date variant (date picker
  and file uploader are separate primitives).
- No example app was changed; the components are exercised by the fixtures.
- Manual screen-reader verification not done (same status as the rest of the
  kit).
