# EJS starter

The EJS counterpart of [`starter-hbs`](../starter-hbs/README.md). One
`EjsEngine` instance from `@nestvexa/engine-ejs` renders Nest MVC pages
(through the Express view bridge) and a Live component template (through
`LiveModule.register({ renderer })`). The default `nestvexa` install stays
Handlebars-only; this example adds the EJS adapter explicitly.

## What it shows

| Route             | What it proves                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`           | `layouts/main.ejs` layout, the `nav` partial alias, `year`/`plural` helpers, `<%= %>` escaping and a Live counter written in EJS. |
| `GET /about`      | A plain `@Render` page with the current link marked `aria-current`.                                                               |
| `GET /contact`    | A form that works without JavaScript: hidden per-session CSRF field, origin check, server validation, post/redirect/get (303).    |
| `GET /api/health` | A native Nest JSON route next to the views.                                                                                       |

The Live counter has two actions and one writable model (`name`, bounded to
60 characters) whose escaped greeting updates while typing. The browser loads
the client through an app-owned `/assets/boot.js` that imports the versioned
URLs from `NestvexaAssetsService` (see the
[client asset guide](../../docs/guides/client-assets.md)).

## Run it

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nestvexa/example-starter-ejs start   # http://127.0.0.1:3114
```

`PORT` overrides the port; the Live origin check follows it.
`pnpm --filter @nestvexa/example-starter-ejs dev` runs the TypeScript source
with `tsx`. Templates live in `views/` and are resolved the same way from
source and compiled entry points.

## Tests

The root Playwright suite starts this example on port **3114**
(`tests/browser/starter-ejs.spec.ts`; override with `NV_E2E_STARTER_EJS_URL`).
It checks layout/partial/helper output, escaping, SEO metadata, the Live
counter and model without a full reload, forged and cross-origin form posts
(403), the complete no-JavaScript validation and success flow, and axe WCAG 2.1
A/AA scans of the page, the Live state and the form errors.

## Security notes

- Templates are trusted code. `<%= %>` escapes `& < > " '`; `<%- %>` is only
  used for `include()`. Live mounts are `SafeHtml` and print through `<%= %>`.
- EJS throws on undefined top-level names; the layout and partial use
  `locals.path` for optional values.
- The contact form checks the `Origin` header and a per-session token (constant
  time comparison) before reading any field. Body parsers are explicit: JSON for
  Live and flat urlencoded bodies limited to 8 KiB for the form.
- The CSP is `script-src 'self'` with no inline scripts or styles.
- `express-session` uses the in-memory store and a per-process secret: guest
  sessions are lost on restart and are not shared between replicas. This is an
  anonymous demonstration identity; production hosts add a persistent session
  store, a deployment secret, `Secure` cookies over HTTPS and real
  authentication.
- The contact form does not send or store anything.
