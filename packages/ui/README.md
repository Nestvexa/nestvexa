# @nestvexa/ui

Optional, unstyled, accessible UI primitives for Nestvexa HBS views and Live
components: dialog, tabs, editable combobox, toast region, sortable table
headers, pagination, disclosure and progress. Markup is rendered on the server by
trusted Handlebars helpers. A small optional browser module adds keyboard and
focus behavior, and an optional stylesheet adds a theme with dark mode, RTL and
reduced-motion support. Alpha software.

This package is **not** part of the `nestvexa` default install. Installing it
changes nothing until you register its helpers and, if you want keyboard
behavior, serve its browser module.

## Install

After owner-authorized publication: `npm install @nestvexa/ui`,
`pnpm add @nestvexa/ui` or `yarn add @nestvexa/ui`. Before publication, use the
workspace or packed tarballs. Node `^22.13.0 || ^24.0.0`, ESM only.

- Runtime dependency: `@nestvexa/views` (for `SafeHtml`).
- No peer dependencies. The helpers work with any `ViewEngineAdapter` that
  forwards Handlebars helper calls, which in practice means
  `@nestvexa/engine-hbs` (directly or through the `nestvexa` umbrella).
- The browser module has no dependencies and does not import
  `@nestvexa/client`.

## Entry points

| Entry                    | Runs in | Contents                                           |
| ------------------------ | ------- | -------------------------------------------------- |
| `@nestvexa/ui`           | Node    | `uiHelpers`, `UiError`, `escapeHtml`               |
| `@nestvexa/ui/browser`   | Browser | `initUi`, `openDialog`, `closeDialog`, `showToast` |
| `@nestvexa/ui/theme.css` | Browser | Optional stylesheet (plain CSS, no build)          |

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

**Sort actions take no arguments.** Live action directives are bare registered
identifiers (see [directives](../../docs/reference/directives.md)), so pass one
action per column, for example `action="sortByName"`, or use `href` links.

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

## Testing

```sh
pnpm --filter @nestvexa/views build
pnpm --filter @nestvexa/engine-hbs build
pnpm --filter @nestvexa/ui build
pnpm exec vitest run tests/ui-helpers.test.ts tests/ui-browser.test.ts
```

[`tests/ui-helpers.test.ts`](../../tests/ui-helpers.test.ts) renders through a
real `HbsEngine`: markup contracts, escaping, rejected ids, hrefs and action
injection. [`tests/ui-browser.test.ts`](../../tests/ui-browser.test.ts) runs
the built module in real Chromium under a strict CSP: focus trap, inert
background, return focus, tabs in LTR and RTL, combobox keyboard and events,
text-only toasts, idempotent init and disposal, mutation-observed insertion,
theme preferences and axe.

## Caveats and limits

- Not yet provided: datepicker, file uploader, drawer, step wizard, popover,
  dropdown menu, breadcrumbs or chart wrapper. The data table is headers
  (`uiSortHeader`) plus `uiPagination` on your own `<table class="nv-table">`.
  There is no selection or filtering helper.
- The combobox filters options rendered on the server (up to 500). There is
  no remote search.
- Tabs use automatic activation. Manual activation is not configurable.
- The keyboard module is tested in Chromium here, and in Chromium, Firefox and
  WebKit through the admin example's Playwright suite.
- No SPA (React/Vue/Svelte) adapter is shipped for these primitives.

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
