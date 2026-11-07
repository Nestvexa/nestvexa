# @nestvexa/ui

Optional, unstyled, accessible UI primitives for Nestvexa HBS views and Live
components: dialog, drawer, tabs, editable combobox, menu button, popover,
tooltip, accordion, disclosure, breadcrumbs, badge, alert, toast region, date
picker, file uploader, step wizard, data table (sortable headers, search,
filters, row selection), pagination and progress. Markup is rendered on the server by
trusted Handlebars helpers. A small optional browser module adds keyboard and
focus behavior, and an optional stylesheet adds a theme with dark mode, RTL and
reduced-motion support. Thin React, Vue and Svelte wrappers render the same
markup for the main primitives (dialog, tabs, menu, toast, date picker, data
table) and reuse the same keyboard module. Alpha software.

This package is **not** part of the `nestvexa` default install. Installing it
changes nothing until you register its helpers and, if you want keyboard
behavior, serve its browser module.

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack`
(written to `artifacts/packages`) and install the `.tgz` files together. After
owner-authorized publication the registry syntax will be `npm install
@nestvexa/ui`, `pnpm add @nestvexa/ui` or `yarn add @nestvexa/ui`. Node
`^22.13.0 || ^24.0.0`, ESM only.

- Runtime dependency: `@nestvexa/views` (for `SafeHtml`).
- Optional peers, only for the framework wrappers: `react` `^19`, `vue`
  `^3.5`, `svelte` `^5`. HBS-only hosts install none of them. The helpers work with any `ViewEngineAdapter` that
  forwards Handlebars helper calls, which in practice means
  `@nestvexa/engine-hbs` (directly or through the `nestvexa` umbrella).
- The browser module has no dependencies and does not import
  `@nestvexa/client`.

## Entry points

| Entry                     | Runs in | Contents                                                                         |
| ------------------------- | ------- | -------------------------------------------------------------------------------- |
| `@nestvexa/ui`            | Node    | `uiHelpers`, `UiError`, `escapeHtml`                                             |
| `@nestvexa/ui/browser`    | Browser | `initUi`, `connectUi`, `openDialog`, `closeDialog`, `showToast`, `menuSelection` |
| `@nestvexa/ui/markup`     | Both    | Markup contract: `dialogMarkup`, `tabsMarkup`, … and `renderMarkup`              |
| `@nestvexa/ui/react`      | Both    | React wrappers (SSR and hydration)                                               |
| `@nestvexa/ui/vue`        | Both    | Vue 3 wrappers (SSR and hydration)                                               |
| `@nestvexa/ui/svelte`     | Both    | Svelte 5 wrappers, shipped as `.svelte` source                                   |
| `@nestvexa/ui/theme.css`  | Browser | Optional stylesheet (plain CSS, no build)                                        |
| `@nestvexa/ui/tokens.css` | Browser | Design tokens only (custom properties, no component styles)                      |

`@nestvexa/ui/browser` is a single self-contained ES module
(`dist/browser/index.js`) with no relative imports, so it can be served as one
static file. It is safe to import in Node: nothing touches `window` or
`document` at module load.

## Why helpers rather than partials

The HBS engine confines partials to the application's own view root, and Live
components render with engine-level helpers only. Shipping `.hbs` files inside
`node_modules` would therefore need copying or a second template root. The
primitives are instead trusted HBS block and inline helpers, registered through
the engine's existing helper mechanism. They behave like partials in templates
(`{{#uiDialog}}…{{/uiDialog}}`), render their block bodies from your own
trusted template through `options.fn(this)`, and work the same in MVC pages and
Live component views.

## Minimal usage

```ts
import { HbsEngine, configureNestvexa } from 'nestvexa';
import { uiHelpers } from '@nestvexa/ui';

const app = await NestFactory.create(AppModule);
// Register before configureNestvexa(): helpers lock at initialization.
app.get(HbsEngine).registerHelpers(uiHelpers());
await configureNestvexa(app);
```

Serve the browser module and theme from your own routes, so a strict
`script-src 'self'; style-src 'self'` CSP keeps working:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Resolved once at startup from trusted package paths, never from requests.
const uiModule = readFileSync(
  fileURLToPath(import.meta.resolve('@nestvexa/ui/browser')),
  'utf8',
);
const uiTheme = readFileSync(
  fileURLToPath(import.meta.resolve('@nestvexa/ui/theme.css')),
  'utf8',
);
// Return them from GET routes with text/javascript and text/css content types.
```

```hbs
<link rel='stylesheet' href='/vendor/nestvexa-ui.css' />
<script type='module' src='/app.js'></script>
```

```js
// app.js (served with script-src 'self')
import { initUi } from '/vendor/nestvexa-ui.js';
initUi();
```

A template:

```hbs
{{uiDialogTrigger
  'product-dialog'
  label=(t 'products:add')
  href='/products/new'
}}
{{#uiDialog
  id='product-dialog'
  title=(t 'products:add')
  closeLabel=(t 'common:close')
  closeOn='product-created'
}}
  {{{productForm}}}
{{/uiDialog}}
```

All labels are required hash arguments so applications pass translated text,
for example from `@nestvexa/i18n`'s `t` helper as a subexpression.

## Helpers

Every helper validates its arguments and throws `UiError` (code `ID` or
`ARGUMENT`) on invalid input, which the engine turns into a `RENDER_FAILED`
view error. Ids, event names, model names and action names use the closed
grammar `[A-Za-z][A-Za-z0-9_-]{0,63}` (`__proto__`, `prototype` and
`constructor` are rejected). Labels are plain text and are always escaped.
Links accept same-origin paths only: they must start with exactly one `/` and
contain no `\` or control characters, so `javascript:` URLs, `//host` and
`/\host` are rejected.

| Helper                                                                                                                | Output and ARIA pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{#uiDialog id title closeLabel [describedBy] [closeOn] [class]}}…{{/uiDialog}}`                                     | Native `<dialog class="nv-dialog" data-nv-ui="dialog" aria-labelledby="{id}-title">` with `<h2 id="{id}-title">`, a close button `data-nv-ui-close aria-label="{closeLabel}"` and `.nv-dialog__body`. `closeOn` renders `data-nv-ui-close-on`. [APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `{{uiDialogTrigger "dialog-id" label [href] [class]}}`                                                                | `<button type="button" data-nv-ui-open aria-haspopup="dialog" aria-controls>`; with `href`, `<a href role="button">` so users without JavaScript navigate to a full page instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `{{#uiTabs id label}}{{#uiTab id label [selected=true]}}…{{/uiTab}}{{/uiTabs}}`                                       | `role="tablist"` (rendered `hidden`, revealed by the browser module) with `role="tab"` buttons `id="{tabs}-{tab}-tab" aria-controls aria-selected tabindex="0/-1"`, then `role="tabpanel" aria-labelledby tabindex="0"`. Inactive panels carry `data-nv-ui-inactive` rather than `hidden`. One to 32 tabs, unique ids, at most one `selected` (default: first). Only `uiTab` blocks may appear directly inside. [APG tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)                                                                                                                                                                                                                                                                                                                     |
| `{{uiCombobox id name label options emptyLabel [value] [countLabel] [placeholder] [model] [required] [describedBy]}}` | `<label for>`, `<input role="combobox" aria-autocomplete="list" aria-expanded aria-controls="{id}-listbox" autocomplete="off">`, `<ul role="listbox" hidden>` with `<li role="option" id="{id}-opt-{n}" data-value aria-selected>`, a value input `id="{id}-value" name data-nv-ui-value` holding the committed value (`type="hidden"`, or with `model` a `type="text"` input carrying the `hidden` attribute and `nv:model`, because Live models bind only native text controls), and a visually hidden `role="status"`. `options` is up to 500 `{ value, label }` objects with unique values. `value` must be one of them. `countLabel` substitutes `{count}`. [APG combobox with list autocomplete](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/) |
| `{{uiToastRegion id label dismissLabel [event] [messages]}}`                                                          | `<section data-nv-ui="toasts" aria-label data-nv-ui-event="toast">` containing a `role="status" aria-live="polite"` list (`data-nv-ui-list`) and a `role="alert"` list (`data-nv-ui-alerts`). `messages` (up to five strings) renders initial toasts, such as flash messages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `{{uiSortHeader label key sort direction (action \| href)}}`                                                          | `<th scope="col">` with `aria-sort="ascending/descending"` **only** on the sorted column (`sort === key`), containing `<button nv:click="{action}">` or `<a href>`. The arrow is `aria-hidden`. `direction` accepts `asc`, `desc`, `ascending` or `descending`. [APG sortable table](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `{{uiPagination pagination label previousLabel nextLabel pageLabel href [navigate=true]}}`                            | `<nav aria-label><ul>` from the Live `Pagination` shape (`paginate()`), with links `href="{href}{page}" aria-label="{pageLabel with {page}}"`, `aria-current="page"` on the current page, gaps as `<li aria-hidden="true">…</li>`, and disabled previous/next as `<span aria-disabled="true">`. `navigate=true` adds `nv:navigate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `{{#uiDisclosure summary [open=true] [id]}}…{{/uiDisclosure}}`                                                        | Native `<details class="nv-disclosure"><summary>`. Works without JavaScript. [APG disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `{{uiProgress id label [value] [max=100] [valueText]}}`                                                               | `<label for>` plus a native `<progress>`. It is indeterminate when `value` is null or omitted, and `aria-valuetext` is set when `valueText` is given. `0 ≤ value ≤ max`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `{{uiVisuallyHidden "text"}}`                                                                                         | `<span class="nv-visually-hidden">`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Navigation, overlays, inputs and data tables

| Helper                                                                                                                                  | Output and ARIA pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{{#uiDrawer id title closeLabel [side=end\|start] [closeOn] [describedBy] [class]}}…{{/uiDrawer}}`                                     | A `uiDialog` with `class="nv-dialog nv-drawer"`, `data-nv-ui-variant="drawer"` and `data-side`. Opened by `uiDialogTrigger`, with the same focus trap, Escape and focus return. `start`/`end` follow the text direction.                                                                                                                                                                                                                                                                                                                         |
| `{{uiBreadcrumbs items label}}`                                                                                                         | `<nav aria-label><ol>`; 1–16 `{ label, href }` items, every item but the last needs a same-origin `href`; the last carries `aria-current="page"`. [APG breadcrumb](https://www.w3.org/WAI/ARIA/apg/patterns/breadcrumb/)                                                                                                                                                                                                                                                                                                                         |
| `{{uiBadge label [count] [max=99] [tone] [live] [id]}}`                                                                                 | `<span class="nv-badge" data-tone>`. With `count`, the number is shown (`aria-hidden`, `99+` above `max`) and `label` (with `{count}`) is visually hidden text. `live=true` adds `role="status"` so morph-updated counts are announced (live notification badge). Tones: `neutral`, `info`, `success`, `warning`, `danger`.                                                                                                                                                                                                                      |
| `{{#uiAlert [tone] [title] [id] [dismissLabel] [live=false]}}…{{/uiAlert}}`                                                             | `warning`/`danger` use `role="alert"`, `info`/`success` `role="status"`, `live=false` none. `title` with `id` labels it. `dismissLabel` renders a `hidden` dismiss button the module reveals; dismissing removes the alert and moves focus to `<main>` if it was inside. [APG alert](https://www.w3.org/WAI/ARIA/apg/patterns/alert/)                                                                                                                                                                                                            |
| `{{#uiAccordion id [level=3] [multiple]}}{{#uiAccordionItem id title [open]}}…{{/uiAccordionItem}}{{/uiAccordion}}`                     | `<hN><button aria-expanded aria-controls>` headers and `role="region"` panels (regions only up to 6 items). Collapsed panels carry `data-nv-ui-collapsed`, which the theme hides only under `@media (scripting: enabled)`. Single-open unless `multiple`. Keys: Enter/Space, ArrowDown/ArrowUp (wrapping), Home, End. [APG accordion](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/)                                                                                                                                                       |
| `{{#uiMenu id label [class]}}{{uiMenuItem label (href \| action \| value) [disabled]}}{{/uiMenu}}`                                      | `aria-haspopup="menu"` button and `role="menu"` list of `role="menuitem"` links, Live action buttons (`nv:click`) or value buttons. Value items dispatch a bubbling `nv-ui-menu-select` event with `detail: { menu, value }`. Disabled items get `aria-disabled` and lose their target. Keys: Enter/Space/ArrowDown open on the first item, ArrowUp on the last; ArrowUp/ArrowDown wrap, Home, End, type-ahead, Escape returns focus, Tab closes; outside clicks close. [APG menu button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) |
| `{{#uiPopover id label [title] [class]}}…{{/uiPopover}}`                                                                                | Disclosure button (`aria-expanded`, `aria-haspopup="dialog"`) controlling a non-modal `role="dialog"` panel labelled by `title` or the button. Opening moves focus into the panel; Escape closes and returns focus; focus leaving or an outside click closes it.                                                                                                                                                                                                                                                                                 |
| `{{#uiTooltip id text [label] [class]}}trigger content{{/uiTooltip}}`                                                                   | A button with `aria-describedby` pointing to a `role="tooltip"` element (described even while hidden). Shown on hover and focus, kept while the pointer is over the bubble, dismissed with Escape without moving focus (WCAG 1.4.13). Needs text content or `label`. [APG tooltip](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)                                                                                                                                                                                                            |
| `{{uiDatePicker id name label [value] [min] [max] [required] [locale] [dateStyle=long] [model] [describedBy]}}`                         | Native `<input type="date">` (the browser provides the calendar and its keyboard support) plus an `<output aria-live="polite">` with the value formatted by `Intl.DateTimeFormat` in UTC, so no time zone shifts the day. `locale` defaults to the nearest `lang` in the browser. Values are strict `YYYY-MM-DD`. With `model`, a hidden text input carries `nv:model.change` and receives the value (Live models do not bind date inputs).                                                                                                      |
| `{{uiFileUpload id label selectedLabel (name \| model) [accept] [multiple] [required] [hint] [dropLabel] [progressLabel cancelLabel]}}` | Labelled `<input type="file">`, a selection list (file names as text with localized sizes) and a `role="status"` count. `dropLabel` adds a drop zone revealed by the module; dropped files are filtered by `accept` and dispatched as `input`/`change`. Without `model` it is a named input for native multipart forms (`UploadsService.receiveForm`); with `model` it emits `nv:upload`, `nv:upload.progress`, `nv:upload.status` and `nv:upload.cancel`, which `@nestvexa/client` drives against `@nestvexa/uploads` (neither is imported).    |
| `{{#uiWizard id label current stepLabel completedLabel [level=2]}}{{#uiWizardStep id title [href]}}…{{/uiWizardStep}}{{/uiWizard}}`     | Server-driven steps: an ordered list with `aria-current="step"`, completed steps announced with a visually hidden suffix and optionally linked, and only the current step's body under a `tabindex="-1"` heading (`stepLabel` with `{step}` and `{total}`). When a Live morph changes `data-nv-ui-current` in place, the module focuses the new heading. 2–16 steps.                                                                                                                                                                             |
| `{{#uiDataTable id caption [selectionLabel] [class]}}<thead>…</thead><tbody>…</tbody>{{/uiDataTable}}`                                  | `<table class="nv-table">` with a caption and a `role="status"` line (`aria-describedby`) announcing filter results and the selection count.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `{{uiTableSearch table label [client] [model] [name] [value] [placeholder] [resultsLabel]}}`                                            | `role="search"` with a labelled `type="search"` input. `client=true` filters rendered rows in the browser (case-insensitive, locale-aware); `model` binds `nv:model.live.debounce.300ms` so the server filters; `name` submits it with a GET form.                                                                                                                                                                                                                                                                                               |
| `{{uiTableFilter table key label allLabel options [client] [model] [name] [value] [resultsLabel]}}`                                     | Native `<select>`; `client=true` matches rows on `data-{key}`, `model` binds `nv:model.change`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `{{uiSelectAll table label}}` / `{{uiSelectRow name value label [checked]}}`                                                            | Header and row checkboxes. Select-all applies to rows visible under the current filter and shows the mixed (`indeterminate`) state; selected rows get `data-nv-ui-selected`. Row checkboxes are named, so a native form posts the selection.                                                                                                                                                                                                                                                                                                     |

**Sort actions take no arguments.** Live action directives are bare registered
identifiers (see [directives](../../docs/reference/directives.md)), so pass one
action per column, for example `action="sortByName"`, or use `href` links.

### Form fields and charts

| Helper                                                                                                                                                                                                              | Output and ARIA pattern                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{{uiTextField id label (name \| model) [type=text] [value] [placeholder] [autocomplete] [minLength] [maxLength] [readOnly] [hint] [error \| field] [required] [disabled] [modelModifiers] [describedBy] [class]}}` | `<div class="nv-field">` with `<label for="{id}">`, a hint `<p id="{id}-hint">`, the `<input id="{id}">` and, only while invalid, `<div id="{id}-error" role="alert">` with one `<p>` per message. The input gets `aria-describedby` (`describedBy`, hint, error), `aria-invalid="true"` while invalid, `required` + `aria-required="true"` and an `aria-hidden` asterisk on the label. `type`: text, email, password, search, tel, url, number. |
| `{{uiTextareaField …same… [rows] [value]}}`                                                                                                                                                                         | The same wiring around a `<textarea>` (`rows` 1–50; `value` is its escaped initial text).                                                                                                                                                                                                                                                                                                                                                        |
| `{{uiSelectField …same… options [value] [placeholder] [autocomplete]}}`                                                                                                                                             | Native `<select>` of 1–500 `{ value, label, disabled? }` options; `placeholder` adds a first empty option so `required` rejects it. `value` must be one of the options.                                                                                                                                                                                                                                                                          |
| `{{uiCheckboxField …same… [value] [checked]}}`                                                                                                                                                                      | Checkbox followed by its label, hint and error.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `{{uiRadioGroupField …same… options [value]}}`                                                                                                                                                                      | `<fieldset role="radiogroup">` named by its `<legend>`; hint and error are on the group (`aria-describedby`, `aria-required`), `aria-invalid` on every radio. The first radio has the field `id` (so a forms error-summary link `#{id}` and Live's focus-first-invalid land on it); the others are `{id}-2`, `{id}-3`, … Up to 100 options.                                                                                                      |
| `{{uiChart id title categoryLabel labels series [type=bar] [description] [min] [max] [locale] [showTable] [class]}}`                                                                                                | `<figure data-nv-ui-chart>` with a `<figcaption id="{id}-title">`, an optional description `{id}-desc`, an `<svg role="img" aria-labelledby aria-describedby>` and a data table `{id}-data` (caption, column per series, `data-value` per cell) that is visually hidden unless `showTable`. `type`: `bar`, `line`, `sparkline`. A legend (`aria-hidden`, the table carries the names) is drawn for 2+ series.                                    |
| `{{#uiChart id type="custom" …}}<canvas …>{{/uiChart}}`                                                                                                                                                             | Container `<div id="{id}-canvas" role="img">` around the block body for a third-party chart (the kit ships none), with the same title, description and data table. Only `custom` accepts a body.                                                                                                                                                                                                                                                 |

**Fields** take either `error` (a string or up to 5 strings) or `field`, a
`@nestvexa/forms` `fieldView(errors, path)` result: its `id`, `errorId` and
messages are used, so the ids match the forms package's error summary links
and `aria-describedby` conventions (`{id}-error`). `name` accepts identifiers,
dotted paths (`address.city`) and bracket paths (`items[0][name]`, `tags[]`).
`model="address.city"` emits `nv:model="address.city"` for Live, and
`modelModifiers` (closed vocabulary: `defer`, `live`, `blur`, `change`, `lazy`,
`number`, `boolean`, `debounce`, `throttle`, `NNNms`) gives
`nv:model.live.debounce.300ms`; the framework wrappers drop `nv:` attributes.

```hbs
{{uiTextField
  id='email'
  name='email'
  label=(t 'profile.email')
  type='email'
  hint=(t 'profile.emailHint')
  field=(fieldView errors 'email')
  required=true
}}
{{uiRadioGroupField
  id='plan'
  model='plan'
  label='Plan'
  options=plans
  value=plan
}}
```

**Charts** are server-rendered SVG with geometry attributes only: no
`<script>`, no `style=` attribute and no event handler, so they render under
`default-src 'self'; style-src 'self'`. Colors and dash patterns come from
classes (`nv-chart__series--1` … `--8`) and the `--nv-chart-1` … `--nv-chart-8`
theme tokens; series 2–8 also differ by dash pattern, and `forced-colors`
draws everything in `CanvasText`. Data is validated: 1–200 `labels`
(≤128 characters each), 1–8 `series` (`[{ name, values }]`, one value per
label; sparklines take one series), values finite numbers within ±1e15
(`NaN`, `Infinity`, strings and `null` are rejected), and optional `min`/`max`
that must contain the data. Bars grow from zero. Axis labels are drawn for up
to 12 categories and truncated to 16 characters; line markers up to 60 points;
the table always lists every value, formatted with `Intl.NumberFormat(locale)`.

```hbs
{{uiChart
  id='sales'
  title='Monthly sales'
  description='Online sales peaked in March.'
  categoryLabel='Month'
  labels=months
  series=sales
  locale='en-US'
}}
{{#uiChart
  id='visits'
  type='custom'
  title='Visits'
  categoryLabel='Day'
  labels=days
  series=visits
}}
  <canvas id='visits-chart' width='640' height='320'></canvas>
{{/uiChart}}
```

A third-party library draws into the custom chart's container from your own
script file, reading the values with `chartData(element)` (see the browser
API) so the data is not duplicated into an inline script.

`uiHelpers({ prefix: 'kit' })` renames every helper (`kitDialog`, …). The
prefix must be `[a-z][a-zA-Z0-9]{0,15}` and may not be `nv`, because the engine
reserves the `nv` + uppercase namespace.

## Browser API (`@nestvexa/ui/browser`)

```ts
interface UiController {
  refresh(root?: ParentNode): void;
  dispose(): void;
}
function initUi(
  root?: Document | Element,
  options?: { window?: Window & typeof globalThis },
): UiController;
function openDialog(
  dialog: HTMLDialogElement,
  opener?: HTMLElement | null,
): void;
function closeDialog(dialog: HTMLDialogElement): void;
function chartData(root: Element):
  | {
      labels: readonly string[];
      series: readonly { name: string; values: readonly number[] }[];
    }
  | undefined;
function showToast(
  region: Element,
  message: string,
  options?: { tone?: 'info' | 'success' | 'error'; timeout?: number },
): HTMLElement;
```

- **`initUi`** installs delegated `click`, `keydown`, `input`, `focusout` and
  captured `close` listeners on the root (default `document`), plus one
  `nestvexa:event` listener on the window and one `MutationObserver`. It is
  idempotent per root: a second call returns the same controller. Nested
  controllers never handle the same event twice. Inserted primitives (for
  example after a Live morph) are initialized automatically. `dispose()`
  removes every listener and the observer.
- **Dialog**: `showModal()` (top layer, inert background), explicit Tab and
  Shift+Tab wrapping, Escape (native `cancel`), backdrop click, close button,
  and `data-nv-ui-close-on` matching a Live browser event name. Initial focus
  goes to `[autofocus]`, else the first focusable element in the body, else
  the first focusable element, else the dialog itself. Focus returns to the
  opener on every close path, including when an open dialog is removed from
  the document. If the opener is gone, focus moves to `<main>`.
- **Tabs**: roving tabindex; ArrowLeft and ArrowRight are mirrored when the
  tablist's computed `direction` is `rtl`; Home and End; automatic activation;
  panels toggled with `hidden`.
- **Combobox**: typing filters options case-insensitively with
  `toLocaleLowerCase(<nearest lang>)`; ArrowDown and ArrowUp open and move
  (wrapping); Alt+ArrowDown opens without moving; Enter commits; Escape closes,
  and a second Escape clears. An empty, closed combobox lets Escape reach an
  enclosing dialog. Clicking an option commits it and keeps focus. Committing
  sets the hidden input and dispatches bubbling `input` and `change` events,
  so `nv:model` and forms observe it. Editing the text clears a stale
  committed value. The status region announces `countLabel` or `emptyLabel`.
- **Toasts**: `showToast` writes `textContent` only. Each toast has a dismiss
  button and is removed after `timeout` milliseconds (default 6000; `0` keeps
  it until dismissed). Hover or focus pauses the timer (WCAG 2.2.1). At most
  five toasts are visible. Error toasts go to the `role="alert"` list. The
  region also renders `nestvexa:event` events whose name equals
  `data-nv-ui-event` and whose payload is `{ message: string, tone? }`. Other
  payloads are ignored.
- **`chartData(root)`** reads a chart's data table (`root` is the figure or an
  element inside it, such as the custom chart's canvas) back into labels and
  numeric series from each cell's `data-value`. It returns `undefined` when no
  well-formed table is found or a value is not finite. Charts need no other
  browser behavior.

## Framework wrappers (`/react`, `/vue`, `/svelte`)

The wrappers render the trees of `@nestvexa/ui/markup` (the builders the HBS
helpers print, so markup cannot drift) and call `connectUi(element)` on mount
([ADR 0033](../../docs/adr/0033-ui-kit-framework-wrappers.md)). Include
`theme.css` (or your own styles) as with HBS.

| Component                                                                                                                                  | Props beyond the HBS hash names                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `Dialog`, `Drawer`, `DialogTrigger`                                                                                                        | body as children/default slot; `onClose` (Vue `close`, Svelte `onclose`)                    |
| `Tabs`                                                                                                                                     | `tabs: [{ id, label, selected?, content }]` (Vue slot `panel-<id>`, Svelte `panel` snippet) |
| `Menu`                                                                                                                                     | `items: [{ label, href or value, disabled? }]`, `onSelect(value)`                           |
| `ToastRegion`                                                                                                                              | handle `show(message, { tone, timeout })` via `ref` / Vue `expose` / `bind:this`            |
| `DatePicker`                                                                                                                               | `defaultValue` (read once), `onChange(value)`                                               |
| `DataTable`, `TableSearch`, `TableFilter` (`field` = `key`), `SelectAll`, `SelectRow` (`defaultChecked`), `SortHeader` (`sortKey`, `href`) | table body as children/default slot                                                         |
| `TextField`, `TextareaField`, `SelectField`, `RadioGroupField`                                                                             | `defaultValue` (read once), `onChange(value)` (Vue `change`, Svelte `onchange`)             |
| `CheckboxField`                                                                                                                            | `defaultChecked` (read once), `onChange(checked)`                                           |
| `Chart`                                                                                                                                    | `type="custom"` mount point as children/default slot; `chartData` is re-exported            |

React uses `className`; Vue and Svelte use `class`/`className` as listed in
their types. Live-only options (`model`, `action`) are not available.

```tsx
import { Dialog, DialogTrigger, Menu } from '@nestvexa/ui/react';

<DialogTrigger target="edit" label="Edit" />
<Dialog id="edit" title="Edit item" closeLabel="Close" onClose={() => setOpen(false)}>
  <EditForm />
</Dialog>
<Menu id="row" label="Actions" items={[{ label: 'Archive', value: 'archive' }]} onSelect={archive} />
```

Svelte: `import { Dialog } from '@nestvexa/ui/svelte'` resolves to `.svelte`
source through the `svelte` export condition, compiled by your Svelte/Vite
toolchain.

## Live integration

- **Dialogs**: keep the `<dialog>` element **outside** a Live component root
  and mount a Live component inside its body. A parent morph would otherwise
  remove the browser-owned `open` attribute. Close it from the server with
  `dispatchLiveEvent(this, 'product-created', …)` and
  `closeOn="product-created"`. See [Live effects](../../docs/guides/live-effects.md).
- **Toasts**: `dispatchLiveEvent(this, 'toast', { message })` from an action.
  The message is user-visible text, never HTML.
- **Tabs and combobox inside Live views** keep working after morphs. The
  observer re-applies state when the server re-renders
  `data-nv-ui-inactive` (the server-selected tab wins).
- **Combobox and Live models**: put `model="field"` on the helper to emit
  `nv:model="field"` on the value input. Live models reject `type="hidden"`,
  so with `model` the value input is a text input carrying the `hidden`
  attribute (not rendered, not focusable, not in the accessibility tree). The
  default (deferred) model keeps the value until the next action.

## Theme (`@nestvexa/ui/theme.css`)

Plain CSS built on custom properties (`--nv-accent`, `--nv-bg`, …):

- A light default; dark through `prefers-color-scheme: dark` unless
  `:root[data-theme="light"]` is set, or forced with `:root[data-theme="dark"]`.
- Logical properties only (`margin-inline`, `inset-inline-end`,
  `border-inline-start`, `text-align: start`), so `dir="rtl"` mirrors the
  layout.
- `prefers-reduced-motion: reduce` removes the dialog and toast animations and
  the button transition.
- `forced-colors: active` uses system colors for selection, active option and
  current page.
- Visible `:focus-visible` rings and 2.5rem minimum targets on primitive
  controls (WCAG 2.5.8).
- `@media (scripting: enabled) { [data-nv-ui-inactive] { display: none } }`
  hides inactive tab panels before the module runs, without hiding them for
  users who have scripting disabled.

## Defaults

| Setting              | Default                          |
| -------------------- | -------------------------------- |
| Helper prefix        | `ui`                             |
| Toast event name     | `toast`                          |
| Toast timeout        | 6000 ms (0 = sticky; max 600000) |
| Visible toasts       | 5                                |
| Toast message length | 500 characters (truncated)       |
| Combobox options     | up to 500                        |
| Tabs per set         | 1–32                             |
| Label length         | 512 characters                   |

## Security

- Helpers are trusted server code. Every attribute and text value is escaped
  (`& < > " ' \` =`). Block bodies come from your own trusted template. Never
  pass browser-supplied HTML as a block body or through triple braces.
- Ids, action names, model names and event names are closed-grammar
  identifiers, so a `nv:click` value can never contain an expression.
- `href` values must be same-origin paths. This blocks `javascript:` and
  protocol-relative URLs, not open redirects inside your own application.
- The browser module never uses `eval`, `Function`, inline handlers or
  `innerHTML`. Toast messages are text nodes. Event payloads are read through
  own data properties only. It works under
  `default-src 'self'; script-src 'self'; style-src 'self'`; the test suite
  asserts zero CSP violations.
- Charts emit no `<script>`, `style=` attribute or event handler; every
  label, title and series name is escaped text and every value a validated
  finite number, so chart data from users cannot inject markup. Field `name`,
  `model` and `modelModifiers` use closed grammars, so they cannot break out
  of their attribute or add a Live expression.
- The `<dialog>` tab-trap is a usability feature, not a security boundary.
  Authorization stays on the server.

## Accessibility

Target: WCAG 2.2 AA for the primitives with the optional theme. Automated
evidence: axe-core runs in real Chromium (LTR and RTL fixtures, dialog open and
closed, dark mode with reduced motion), plus keyboard tests for every
interactive primitive. Explicit exceptions and limits:

- Manual screen-reader verification is documented in the
  [accessibility checklist](../../docs/testing/accessibility-checklist.md) and
  has **not** yet been executed.
- The combobox has no JavaScript fallback for choosing values: without the
  module the hidden value keeps its server-rendered default and the text input
  is free text. Pair it with server validation, or render a native `<select>`
  for no-JavaScript-critical forms.
- Dialogs need the browser module. Use `href` on `uiDialogTrigger` so the
  trigger navigates to an equivalent full page without JavaScript.
- Toasts are polite announcements. Do not put the only copy of critical
  information in a toast that auto-dismisses.
- Without the theme, focus indicators and contrast are the browser's and the
  application's responsibility.

## Performance

Helpers run synchronously, with no I/O and no shared mutable state. The browser
module is a single small file (no framework); event delegation keeps a constant
number of listeners per root. Combobox filtering is linear in the option count
(at most 500).

## Compatibility

Alpha `0.1.0-alpha.0`. Helper names, hash arguments and the `data-nv-ui-*`
attribute conventions are the public contract and follow the repository's
compatibility policy. Requires the HBS engine's `registerHelpers` API and
`this` forwarding for block helpers.

## Links

[UI kit guide](../../docs/guides/ui-kit.md) ·
[i18n guide](../../docs/guides/i18n.md) ·
[Accessibility checklist](../../docs/testing/accessibility-checklist.md) ·
[Engine](../engine-hbs/README.md) · [Changelog](../../CHANGELOG.md)

Examples: [`examples/admin-i18n`](../../examples/admin-i18n) (HBS/Live pages on
the helpers) and the `/kit` page of
[`examples/inertia-react`](../../examples/inertia-react) (React wrappers).

## Status and limits

Status: **Partial**. The HBS/Live helpers, the keyboard module, the theme,
the form-field and chart wrappers, and the React, Vue and Svelte wrappers for
the main primitives work and are tested (SSR parity, keyboard, CSP and axe
checks).

- Charts are bar, line and sparkline only, with two value ticks (min and max,
  plus zero when the range crosses it), no interactive tooltips and at most
  200 labels and 8 series; anything else is a `type="custom"` chart drawn by
  your own library. Bars and lines cannot be mixed in one chart.
- Field wrappers are single controls: no multi-select, file, date (use
  `uiDatePicker`) or checkbox-group variant; build those from `uiCheckboxField`
  inside your own `<fieldset>`.
- The Vue and Svelte wrappers have no runnable example page; only the React
  wrappers have one (EXT-020).
- The framework wrappers cover dialog/drawer, dialog trigger, tabs, menu,
  toast region, date picker, the data table pieces, the form fields and the
  chart. Accordion, popover,
  tooltip, breadcrumbs, badge, alert, file upload, wizard, combobox,
  pagination and progress are HBS-only for now.
- Wrappers are uncontrolled (the keyboard module owns open/selected state);
  changing their props re-renders the attributes they own.
- Manual screen-reader verification has not been executed (see
  Accessibility).
- Client-side table filtering works on the rendered rows only; use `model` or
  a GET form for server-side search over paginated data.
- Menus, popovers and accordions reset to their server state when a Live
  morph restores `data-nv-ui-collapsed` (the server state wins, as with tabs).
- The date picker relies on the native date input; browsers without one fall
  back to a text input that still submits `YYYY-MM-DD` and is validated on the
  server.
- Dark mode needs the page surface to use the tokens (for example
  `body { background: var(--nv-bg); color: var(--nv-text) }`); the theme does
  not style `body`.
- The combobox filters options rendered on the server (up to 500). There is
  no remote search.
- Tabs use automatic activation. Manual activation is not configurable.
- `tests/ui-browser.test.ts` runs in Chromium only;
  `tests/ui-primitives-browser.test.ts` and `tests/ui-adapters.test.ts`
  default to Chromium and cover Firefox and WebKit with `NV_UI_BROWSERS`, and
  the admin example's Playwright suite runs in all three.

## Testing

```sh
pnpm --filter @nestvexa/ui test
```

Runs `tests/ui-helpers.test.ts`, `tests/ui-primitives.test.ts`,
`tests/ui-browser.test.ts`, `tests/ui-primitives-browser.test.ts` and
`tests/ui-adapters.test.ts`; the tests import `packages/*/dist`, so run
`pnpm --filter @nestvexa/ui... build` first. Set
`NV_UI_BROWSERS=chromium,firefox,webkit` to run the browser tests in every
engine.

[`tests/ui-primitives.test.ts`](../../tests/ui-primitives.test.ts) covers the
navigation, overlay, input and data-table helpers' markup, escaping and
rejected input;
[`tests/ui-primitives-browser.test.ts`](../../tests/ui-primitives-browser.test.ts)
runs keyboard, focus, RTL, no-JavaScript and axe checks for them under a strict
CSP.

[`tests/ui-adapters.test.ts`](../../tests/ui-adapters.test.ts) bundles React,
Vue and Svelte fixtures, checks that their SSR output is canonically equal to
the HBS helpers' markup, hydrates them under a strict CSP and drives the
dialog, tabs, menu, toasts, date picker, data table and form fields from the
keyboard with axe checks and unmount/remount (charts are checked to stay in
the SVG namespace after a client-side remount).

[`tests/ui-helpers.test.ts`](../../tests/ui-helpers.test.ts) renders through a
real `HbsEngine`: markup contracts, escaping, rejected ids, hrefs and action
injection. [`tests/ui-browser.test.ts`](../../tests/ui-browser.test.ts) runs
the built module in real Chromium under a strict CSP: focus trap, inert
background, return focus, tabs in LTR and RTL, combobox keyboard and events,
text-only toasts, idempotent init and disposal, mutation-observed insertion,
theme preferences and axe.

Browser specs run separately through Playwright in three browsers:
[`tests/browser/admin-ui-kit.spec.ts`](../../tests/browser/admin-ui-kit.spec.ts)
exercises the primitives in the admin example and
[`tests/browser/inertia-react-ui-kit.spec.ts`](../../tests/browser/inertia-react-ui-kit.spec.ts)
the React wrappers on the `/kit` page.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
