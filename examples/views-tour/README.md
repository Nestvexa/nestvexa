# Views tour

One Express application on the `nestvexa` umbrella that shows the view
features of `@nestvexa/views` and a few Live client directives:

| Page                                       | Feature                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin`                                   | `@Render('admin::dashboard')` from the `admin` namespace (`modules/admin/views`)                                                                              |
| `/admin/settings`                          | The application overrides `admin::settings` at `views/vendor/admin/settings.hbs`                                                                              |
| `/?theme=dark`                             | `engine.render('home', model, { theme })`: the `dark` theme overrides `layout.hbs`; `home.hbs` comes from the base views. Unknown themes fall back to default |
| `/posts?role=editor`, `/posts?role=viewer` | Per-request `can`/`cannot` helpers (`permissionHelpers`), failing closed for unknown roles                                                                    |
| `/posts/granted?role=…`                    | `@Render` with precomputed decisions (`grantPermissions`)                                                                                                     |
| `/missing`, `/boom`                        | Opt-in error pages from `configureNestvexa(app, { errorPages })`: 404/5xx views for browsers, Nest JSON for API clients, no 5xx details on the page           |
| `/` (Live panel)                           | `nv:cloak` with the shipped `[nv\:cloak]{display:none!important}` rule, and `nv:class` toggling `is-urgent`/`is-archived` from boolean state                  |
| `/lazy`                                    | A `lazy: 'visible'` Live component below the fold: a server placeholder (`role="status"`, `aria-busy`) until it scrolls into view, then one `_sync` load      |

The role query parameter only makes the permission tour visible. A real
application binds the check to its authenticated principal, and hiding a control
never replaces authorization in the route or action.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nestvexa/example-views-tour start
```

Visit `http://127.0.0.1:4100`. `PORT` overrides the port.
`VIEWS_TOUR_DEV_ERRORS=1` turns on the development error page (error chain,
stacks, failing template and line); never use it in production.

The page CSP is `script-src 'self'; style-src 'self'` with no inline styles: the
client changes classes, never `style`. Sessions use the in-memory
`express-session` store with a random secret, for local demonstration only.

## Tests

`tests/browser/views-tour.spec.ts` (root Playwright suite, port 4100) covers
every row above in Chromium, Firefox and WebKit, including CSP reports and axe
checks. `tests/umbrella-views.test.ts` covers the same umbrella wiring over
HTTP on Express and Fastify.
