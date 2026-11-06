# Admin i18n example (Phase 14)

A small catalog admin built with the `nestvexa` umbrella (HBS + Live) and every
optional Phase 14 extension:

| Feature                                                                                               | Package                   | Where                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| English / Arabic (RTL) switch                                                                         | `@nestvexa/i18n`          | `locales/`, `views/layout.hbs`, `POST /locale`                                 |
| Dialog, tabs, combobox, toast, table, ...                                                             | `@nestvexa/ui`            | `views/admin.hbs`, `views/product-*.hbs`                                       |
| Server-enforced feature flags                                                                         | `@nestvexa/flags`         | `ai-assistant` (on), `bulk-export` (off)                                       |
| Assistant with approval-required tool                                                                 | `@nestvexa/ai`            | `src/assistant.ts`, `POST /admin/assistant-stream`                             |
| Offline drafts, read-only snapshot                                                                    | `@nestvexa/offline`       | `public/admin.js`, `views/product-form.hbs`                                    |
| Menu, popover, tooltip, drawer, accordion, date picker, uploader, wizard, searchable/selectable table | `@nestvexa/ui`            | `GET /admin/kit` (`views/kit.hbs`), `POST /admin/kit/archive`                  |
| Render budget warnings, trace context                                                                 | `@nestvexa/observability` | `renderBudgetInstrumentation()` in the Live policy, `traceContextMiddleware()` |

The assistant uses the deterministic **test provider**. It replays scripted
text and is labeled in the UI as "not an AI model". Try "archive the desk lamp"
(the tool call waits for your approval) or "write a long report" (press Stop
to cancel it).

## Run

```sh
pnpm install
pnpm build
pnpm --filter @nestvexa/example-admin-i18n start   # http://127.0.0.1:3110/admin
```

`PORT` overrides the port. The three-browser tests are
`tests/browser/admin-i18n.spec.ts` and `tests/browser/admin-ui-kit.spec.ts`
(the UI kit page; `ADMIN_I18N_URL` points it at another port).

The UI kit page (`/admin/kit`, linked from the admin page) shows the second
UI kit slice over your session's catalog: the table filters rows in the
browser, and its checkboxes post the selection to `POST /admin/kit/archive`
(CSRF-checked, at most 100 ids, only your own active products). The wizard is
driven by `?step=`. The uploader demonstrates selection, drag and drop and the
announced count only; this example has no upload endpoint. While developing,
`renderBudgetInstrumentation()` prints `NESTVEXA_RENDER_BUDGET` warnings (for
example a slow first render) to stderr; it is disabled when
`NODE_ENV=production`. It runs with `pnpm test:e2e`, which starts
this server through `playwright.config.ts`.

## How the pieces fit

- **Locale**: `I18n.forRequest(request)` negotiates the locale on every request,
  in this order: `?lang=`, the `nv-locale` cookie, `Accept-Language`, then
  English. Only `en` and `ar` are ever accepted. Pages use
  `LocaleViewInterceptor`, which adds `i18n` to the view model and sets
  `Content-Language` and `Vary`. Live components expose the locale as a
  `@Computed() i18n`, so it is never stored in a snapshot and never used for
  authorization. Validation errors are stored as translation keys and
  translated at render time. Arabic-Indic digits are accepted in prices.
- **Helpers**: `main.ts` calls `HbsEngine.registerHelpers(...)` with the i18n,
  UI and flag helpers before `configureNestvexa(app)`.
- **Dialog**: the native `<dialog>` sits outside any Live root and contains the
  `product-form` Live component. `closeOn="product-created"` closes it when the
  component dispatches that browser event, and focus returns to the trigger.
  The trigger links to `/admin/products/new`, so the form also works without
  JavaScript: it posts natively to `POST /admin/products`, and a `<noscript>`
  select replaces the combobox.
- **Flags**: `liveFlagPolicy` checks `ai-assistant` before the action allowlist
  for every assistant request, including `$mount` and the stream.
  `GET /admin/export.csv` is guarded by `@RequireFlag('bulk-export')` and
  returns 404 while the flag is off. Templates use `{{#if (flag "...")}}` with a
  per-request flag snapshot.
- **Assistant**: the stream route authorizes with `LiveRuntime.authorizeStream`
  and streams `AiAssistant.stream(...)` through `createTextStreamResponse`.
  A tool call becomes one pending approval tied to the session identity. Approve
  and Reject act only on the call id the server rendered (`shownCallId`).
- **Offline**: the layout renders `draftScope(secret, identity)`. Only fields
  marked `data-nv-draft-field` are stored (name, price, notes; never the CSRF
  input). If a save fails because the network is down, the draft is kept and a
  message appears. Reconnecting only changes the message: you reload and save
  again yourself. The logout form (`data-nv-logout`) clears drafts in every
  tab. The response also sends `Clear-Site-Data: "storage"` as defense in
  depth. "Refresh activity" shows an inert, labeled copy of the last activity
  list when the request fails offline.

## Demonstration limits

Guest sessions, the in-memory catalog, AI conversations, flag rules and the
draft secret all live in this one process and reset on restart. A real admin
product supplies authentication, a persistent session store, stable secrets,
HTTPS cookies, a database with resource-level authorization, and a real model
provider. See [`packages/ai/README.md`](../../packages/ai/README.md) for how to
connect one.
