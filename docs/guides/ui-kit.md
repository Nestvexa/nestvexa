# UI kit: accessible primitives with Live, i18n, RTL and themes

`@nestvexa/ui` is an optional package. It is not installed by `nestvexa`, and
nothing changes until you register its helpers. This guide builds a small
product screen: a dialog containing a Live form, tabs, a category combobox, a
sortable and paginated table, and toasts. The screen supports English and
Arabic (RTL), dark mode and reduced motion. The
[package README](../../packages/ui/README.md) is the complete API reference.

## 1. Register helpers and serve the assets

```ts
import { NestFactory } from '@nestjs/core';
import { HbsEngine, configureNestvexa } from 'nestvexa';
import { I18n } from '@nestvexa/i18n';
import { uiHelpers } from '@nestvexa/ui';

const app = await NestFactory.create(AppModule);
const engine = app.get(HbsEngine);
engine.registerHelpers(app.get(I18n).helpers()); // t, dir, lang, formatDate, ...
engine.registerHelpers(uiHelpers()); // uiDialog, uiTabs, ...
await configureNestvexa(app); // helpers lock here
```

Serve `@nestvexa/ui/browser` (one file) and `@nestvexa/ui/theme.css` from
`GET` routes in your own controller, under `script-src 'self'` and
`style-src 'self'`. Resolve them once at startup with
`import.meta.resolve(...)`, never from request input. Then start the module from
your application script:

```js
import { initUi } from '/vendor/nestvexa-ui.js';
initUi(); // idempotent; observes later Live morphs
```

## 2. Layout: language, direction and theme

```hbs
<html lang='{{lang}}' dir='{{dir}}'>
  <head>
    <link rel='stylesheet' href='/vendor/nestvexa-ui.css' />
    {{nvScripts}}
    <script type='module' src='/app.js'></script>
  </head>
  <body>
    <main>{{body}}</main>
    {{uiToastRegion
      id='toasts'
      label=(t 'common:notifications')
      dismissLabel=(t 'common:dismiss')
      messages=flash
    }}
  </body>
</html>
```

- The [i18n guide](i18n.md) explains how `lang`/`dir` come from the
  negotiated locale. The theme uses logical CSS properties, so `dir="rtl"`
  mirrors toasts, tabs, borders and alignment without extra rules. Tab arrow
  keys follow the computed direction.
- Dark mode follows `prefers-color-scheme`. To offer a user choice, render
  `data-theme="dark"` or `data-theme="light"` on `<html>` from a stored
  preference. This is presentation state, never an authorization input.
- Reduced motion: the theme disables its animations under
  `prefers-reduced-motion: reduce`. Your own CSS should do the same.

## 3. Dialog with a Live form

Keep the `<dialog>` outside the Live root and mount the component inside it, so
a parent morph never removes the browser-owned `open` attribute:

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
  {{productForm}}
{{/uiDialog}}
```

`productForm` is a `SafeHtml` from `live.mount(ProductForm, request)`. The
`href` keeps the trigger useful without JavaScript, because it navigates to a
full page that mounts the same component. After a successful save, the
component closes the dialog and announces the result:

```ts
@Action() create(): void {
  // ...validate with translated messages, persist...
  dispatchLiveEvent(this, 'product-created', { id: product.id });
  dispatchLiveEvent(this, 'toast', {
    message: this.translations.t(this.locale, 'products:created', {
      name: product.name,
    }),
  });
}
```

Focus returns to the trigger when the dialog closes. Toast payloads are text:
markup in a product name stays literal.

## 4. Tabs

```hbs
{{#uiTabs id='admin' label=(t 'admin:sections')}}
  {{#uiTab id='products' label=(t 'admin:products')}}…{{/uiTab}}
  {{#uiTab id='assistant' label=(t 'admin:assistant')}}…{{/uiTab}}
  {{#uiTab id='settings' label=(t 'admin:settings')}}…{{/uiTab}}
{{/uiTabs}}
```

Without JavaScript, every panel is visible and the tablist stays hidden. With
the module, the tablist appears and inactive panels are hidden. Under
`@media (scripting: enabled)` the theme also hides inactive panels before the
module runs, which avoids a flash of stacked content.

## 5. Combobox in a Live form

```hbs
{{uiCombobox
  id='product-category'
  name='category'
  model='category'
  label=(t 'products:category')
  options=categoryOptions
  value=category
  emptyLabel=(t 'common:noMatches')
  countLabel=(t 'common:resultCount')
}}
```

`categoryOptions` is a computed array of `{ value, label }` with translated
labels. The committed value lives in a `hidden` text input that carries
`nv:model="category"` (Live models do not bind `type="hidden"` inputs). The server must still validate `category` against its
own allowlist, because a browser can submit any value.

## 6. Sortable, paginated table

```hbs
<table class='nv-table'>
  <caption>{{t 'products:title'}}</caption>
  <thead><tr>
      {{uiSortHeader
        label=(t 'products:name')
        key='name'
        sort=sort
        direction=direction
        action='sortByName'
      }}
      {{uiSortHeader
        label=(t 'products:price')
        key='price'
        sort=sort
        direction=direction
        action='sortByPrice'
      }}
    </tr></thead>
  <tbody>…</tbody>
</table>
{{uiPagination
  pagination
  label=(t 'common:pagination')
  previousLabel=(t 'common:previous')
  nextLabel=(t 'common:next')
  pageLabel=(t 'common:pageN')
  href='/products?page='
  navigate=true
}}
```

Only the sorted column gets `aria-sort`. Live actions are bare identifiers,
so use one action per sortable column. `pagination` is the result of
`paginate()` from `nestvexa`. Format prices with `{{formatCurrency price "USD"}}`
from `@nestvexa/i18n`.

## 7. Testing your screens

- Keyboard: Tab into the trigger, Enter opens, Tab and Shift+Tab stay inside,
  Escape closes and focus returns. On tabs, use Arrow, Home and End keys (the
  arrows are mirrored in RTL). On the combobox, type, use Arrow keys, Enter,
  then Escape twice.
- Automated: run axe in both `ltr` and `rtl`, and emulate
  `reducedMotion: 'reduce'` and `colorScheme: 'dark'` with Playwright.
  [`tests/ui-browser.test.ts`](../../tests/ui-browser.test.ts) shows the
  pattern.
- Manual: work through the
  [accessibility checklist](../testing/accessibility-checklist.md) with real
  screen readers before a release.

## 8. Navigation, overlays, inputs and data tables

```hbs
{{uiBreadcrumbs crumbs label=(t 'kit:breadcrumb')}}
{{uiBadge (t 'kit:unread' count=unread) count=unread live=true id='unread'}}
{{#uiMenu id='row-actions' label=(t 'kit:actions')}}
  {{uiMenuItem (t 'kit:menu.admin') href='/admin'}}
  {{uiMenuItem (t 'products:archive') action='archive'}}
  {{uiMenuItem (t 'kit:menu.copy') value='copy-link'}}
{{/uiMenu}}
{{#uiPopover
  id='help' label=(t 'kit:help') title=(t 'kit:helpTitle')
}}…{{/uiPopover}}
{{#uiTooltip
  id='vat' text=(t 'kit:priceTip') label=(t 'kit:priceHelp')
}}?{{/uiTooltip}}
{{uiDialogTrigger 'filters' label=(t 'kit:openFilters')}}
{{#uiDrawer
  id='filters' title=(t 'kit:filters') closeLabel=(t 'common:close')
}}…{{/uiDrawer}}
{{uiDatePicker id='launch' name='launch' label=(t 'kit:launch') locale=lang}}
{{uiFileUpload
  id='files'
  name='files'
  label=(t 'kit:attachments')
  accept='.png,.pdf'
  multiple=true
  selectedLabel=(t 'kit:selectedFiles')
  dropLabel=(t 'kit:drop')
}}
```

- **Menus** report value items through a bubbling `nv-ui-menu-select` DOM
  event; link and `action` items behave natively or through Live.
- **Drawers** are dialogs: open them with `uiDialogTrigger`, close them from
  the server with `closeOn`, and keep them outside Live roots like dialogs.
- **Date picker**: the native input supplies the calendar; the formatted
  `<output>` follows the page locale. Pass `model` for Live (a hidden text
  input carries `nv:model.change`).
- **File uploader**: without `model` it posts in a native multipart form (for
  example to a route using `UploadsService.receiveForm`); with `model` it
  emits the Live upload directives handled by `@nestvexa/client`.
- **Wizard**: drive `current` from server state (a query parameter, form step
  or Live state). Link completed steps with `href`. After a Live step change
  focus moves to the step heading.
- **Data tables**: wrap rows in `uiDataTable`, add `uiTableSearch` and
  `uiTableFilter` with `client=true` for small tables or `model` for server
  filtering, and put `uiSelectAll`/`uiSelectRow` in a `<form>` so a bulk
  action is a plain POST. See `examples/admin-i18n` (`/admin/kit`).

## Limits

No chart wrapper or form-field wrappers yet. The combobox needs JavaScript to
choose values, and dialogs and drawers need JavaScript, so provide `href`
fallbacks. Menus, popovers and accordion panels stay readable without
JavaScript (the theme hides them only when scripting is enabled). See the
README's caveats.
