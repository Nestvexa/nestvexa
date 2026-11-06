# Integration matrix: every rendering mode in one Nest server

One NestJS 12 (Express) process serves every route from the master prompt's
success demonstration (section 1.5) at the same time: Handlebars MVC, Live
components, three Inertia roots (React, Vue, Svelte) with server-side
rendering, framework islands, a universal server action, authorized realtime
updates over Server-Sent Events and an ordinary REST controller. It uses only
published package entry points (`nestvexa`, `@nestvexa/*` and their documented
subpaths).

This example is the repository's `apps/playground` equivalent: the single
place to try every feature together. There is no separate `apps/` directory.

## Routes

| Route                                      | Renderer                       | What it shows                                                                                                                                                                                                    | Ledger     |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `/`                                        | HBS                            | Layout, application helpers (`price`, `year`) and built-in block helpers, escaped interpolation, `description`/Open Graph/canonical metadata                                                                     | VISION-029 |
| `/counter`                                 | Live + HBS                     | Server state, actions, validated input with an accessible error, `nv:confirm`, an Alpine widget calling `$live.call`, no full reload                                                                             | VISION-030 |
| `/products`                                | Live + HBS                     | Debounced search (URL-bound), server sort with `aria-sort`, paginated table with no-JS links and `nv:navigate`, validated create form, image upload through `@nestvexa/uploads` and an owner-only image download | VISION-031 |
| `/admin/react`, `/users`, `/users/create`  | Inertia React + SSR            | Navigation inside the root, deferred `stats`, optional `extra` on a partial reload, form with server validation errors and flash                                                                                 | VISION-032 |
| `/admin/vue/...`                           | Inertia Vue + SSR              | Same protocol and page flow                                                                                                                                                                                      | VISION-033 |
| `/admin/svelte/...`                        | Inertia Svelte + SSR           | Same protocol and page flow                                                                                                                                                                                      | VISION-034 |
| `/hybrid`                                  | HBS + islands + Live + actions | React chart, Vue feed and Svelte widget islands (separate lazy chunks), an independent Live widget, a `@nestvexa/actions` call                                                                                   | VISION-035 |
| `/realtime`                                | Live + SSE                     | Cross-session refresh on a public channel; an operator-only channel that guests are never subscribed to                                                                                                          | VISION-036 |
| `/api/health`, `/secure`, `/square/:value` | Native Nest                    | Controller-scoped guard, `ParseIntPipe`, interceptor and exception filter run unchanged                                                                                                                          | VISION-037 |

Each Inertia root has its own Vite config, `base` (`/build/<root>/`),
manifest, asset version and in-process SSR bundle (`moduleSsrRenderer`), as in
[`inertia-mixed`](../inertia-mixed/README.md). A link from one root to another
is a full page load.

## Build and run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build                                              # or:
pnpm --filter @nestvexa/example-integration-matrix build  # tsc, vue-tsc, svelte-check, 6 Vite builds, islands
pnpm --filter @nestvexa/example-integration-matrix start  # http://127.0.0.1:3123
```

`PORT` overrides the port (the origin used for CSRF/origin checks follows it).
`UPLOADS_DIR` overrides the private temporary upload directory (default: the OS
temp directory).

## Tests

[`tests/browser/integration-matrix.spec.ts`](../../tests/browser/integration-matrix.spec.ts)
covers every route above in Chromium, Firefox and WebKit, with axe
(WCAG 2.1 A/AA tags) checks on the HBS, Live, Inertia, hybrid and realtime
pages. The root `playwright.config.ts` starts this example on port **3123**.
For a run on another port, set `PORT` for the server and
`NV_E2E_INTEGRATION_MATRIX_URL` for the spec.

## Security notes

- **Identity** is an anonymous `express-session` guest session; one click on
  `/realtime` turns it into a demonstration "operator". There are no accounts
  or passwords. The sign-in is a CSRF-checked POST that regenerates the session
  and revokes the previous binding's realtime connections. Production hosts
  supply real authentication, a persistent session store, a deployment secret
  and HTTPS-only cookies.
- **One identity policy** (`src/identity.ts`) feeds Live, uploads, actions and
  realtime. The binding includes the role, so a Live snapshot, upload token or
  realtime token from one identity is refused for another.
- **CSRF:** Live, uploads and actions use the per-session token
  (`<meta name="nestvexa-csrf">` for actions). The Inertia admin controller has
  its own guard: the official client echoes the `XSRF-TOKEN` cookie in
  `X-XSRF-TOKEN`; posts without it get `403`.
- **Authorization:** every Live action is allow-listed per component;
  `raiseAlert` additionally requires an operator binding (checked in the policy
  and again in the action). The realtime signer only signs channels that
  `authorizeChannel` allows, so guests never receive alert events, and alert
  text is never rendered for guests.
- **CSP:** HBS pages send `script-src 'self'`; `/hybrid` adds
  `style-src 'unsafe-inline'` because Svelte islands inject component styles.
  Inertia documents get a per-request nonce with `'strict-dynamic'` from
  `cspNonceMiddleware`, mounted on `/admin` only.
- **Uploads** are magic-byte checked (PNG/JPEG, 512 KB), stored outside any
  served directory, finalized only by the uploading identity and downloaded
  through an owner check.
- All demonstration data (products per identity, admin users per root, the
  realtime feed and alerts, scores) is bounded and in process memory; it
  resets on restart and does not coordinate replicas.

## Known gaps

- Not a multi-replica deployment: realtime uses the in-memory broker
  (`RespRealtimeBroker` from `@nestvexa/realtime`, covered by
  `tests/realtime.test.ts`), sessions and Live state are process-local.
- The React root uses in-process SSR here; the official separate Inertia SSR
  server process is shown in [`inertia-react`](../inertia-react/README.md).
- The action descriptor in `client/islands/islands.ts` is written by hand;
  [`actions-basic`](../actions-basic/README.md) shows the generated, typed
  client.
- No i18n/RTL switch, nested modals, multi-step wizard, GraphQL operation or
  tenant separation in this example; see `admin-i18n`, `starter-live`,
  `auth-forms` and `multi-tenant` for those showcase pages.
