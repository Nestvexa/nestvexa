# React with Inertia, Vite and SSR

This guide wires a Nest host (`@nestvexa/inertia`) to React pages through the
official `@inertiajs/react` 3.10.0 client, built with Vite 8 and rendered on the
server. The complete, tested setup is
[`examples/inertia-react`](../../examples/inertia-react) (port 3106).

## Layout

```
src/main.ts          Nest host (controllers, InertiaModule, CSP, static files)
src/page-types.ts    page props shared by controllers and components (types only)
client/setup.ts      page registry + layouts (shared by both entries)
client/app.tsx       browser entry
client/ssr.tsx       SSR entry
client/pages/**      one component per Inertia page name
vite.config.ts
```

## Pages

```ts
// client/setup.ts
export const pages = createPageRegistry(
  import.meta.glob<ReactPageModule>('./pages/**/*.tsx'),
  { base: './pages/', extensions: ['.tsx'] },
);
export const layout = (name: string) =>
  name.startsWith('Users/') ? [AppLayout, UsersLayout] : AppLayout;
```

`@InertiaPage('Users/Index')` renders `client/pages/Users/Index.tsx`. Only
registry pages can render; the lazy glob gives each page its own chunk. Layouts
returned by `layout` are persistent (state survives visits) and may be nested.

Typed props: export a props map from `src/page-types.ts` and use it on both
sides (`AppPages['Home']` as the component props; the controller returns
`ServerProps<AppPages['Home']>`, which also accepts `defer()`/`optional()`).

## Entries

```tsx
// client/app.tsx
import '@vitejs/plugin-react/preamble';
import { mountReactInertiaApp } from '@nestvexa/react';
void mountReactInertiaApp({ pages, layout, title: (t) => `${t} · Acme` });
```

`mountReactInertiaApp` hydrates (`hydrateRoot`) when the server markup carries
`data-server-rendered`, otherwise it mounts; hydration mismatches are reported
through `onError(error, 'recoverable')`.

```tsx
// client/ssr.tsx
export const render = createReactSsrRender({ pages, layout, title });
if (isMainModule(import.meta.url)) startReactSsrServer(render, { port: 13716 });
```

## SSR choice: separate process

The React example runs the official Inertia SSR HTTP server
(`node --env-file=ssr.production.env dist/ssr/ssr.js`, loopback port 13716) and
the Nest host uses `HttpSsrGateway`. This isolates React rendering from the Nest
event loop and is the deployment model upstream documents. The same bundle can
be used in-process with `moduleSsrRenderer` (as the Vue/Svelte examples do).

```ts
ssr: {
  renderer: new HttpSsrGateway({ url: 'http://127.0.0.1:13716', timeoutMs: 3000 }),
  mode: 'fallback', // serve the client-rendered document if SSR fails
},
```

If the SSR process is down or a page throws, `fallback` mode serves the normal
client-rendered document (status unchanged) and logs a warning; `strict` turns
the failure into a `500`. Error details never reach the browser.

## Forms, validation and uploads

Use `useForm` and post to Nest; throw `InertiaValidationException({ field:
message })` and the official client shows `form.errors`. Uploads use the same
API with a `File` value (`forceFormData: true`); the example validates with
Nest's `FileInterceptor` and redirects with flash data. CSRF stays host-owned
(the example mirrors a session token into `XSRF-TOKEN`).

## Live validation (Precognition)

`useForm('post', '/features/signup', data)` enables Precognition in the
official client: `form.validate('name')` (here on blur) sends a
validation-only request and `form.invalid()`/`form.valid()`/`form.errors`
reflect the answer. Declare the Nest route with `@Precognitive(schema)`; the
same `@nestvexa/forms` adapter validates the real submission in the handler
(see `examples/inertia-react/src/features.ts` and the
[Inertia guide](inertia.md#precognition-live-validation)).

The upload page validates files too: `useForm('post', '/uploads', data)
.validateFiles()` sends the chosen file as a multipart Precognition request,
and the route lists its `FileInterceptor` in `@Precognitive(rules, {
interceptors })` so the file is parsed before the rules run (see
[Files: `validateFiles()`](inertia.md#files-validatefiles)).

## Client-owned features verified in the browser

`/features` in the example is a tour of the official client's features, each
asserted against the wire traffic in `tests/browser/inertia-react-features.spec.ts`:
hover prefetch reused on click (`<Link prefetch="hover">`), instant visits
(`<Link component="Features/Slow">` renders before the server answers),
`router.visit`/`router.post` and `<Link method="post">`, view transitions
(when the browser has `document.startViewTransition`), `usePoll` partial
reloads, `<InfiniteScroll>` over a `scroll()` prop and a `merge()` prop,
`<WhenVisible>` over an `optional()` prop, `useRemember`/remembered `useForm`,
`once()` props reused with `X-Inertia-Except-Once-Props`, history encryption
(`encryptHistory`) with `clearHistory` invalidating old entries, `optimistic`
visits with rollback on a validation error, Precognition, and a 2.6 MB page
payload over SSR and XHR. Scroll management (visits reset the window and
`scroll-region` elements, `preserveScroll` keeps them, back/forward restores
them, `#hash` visits scroll to the anchor) and the progress bar
(`showProgress: false` hides it) run through the shared
`defineScrollAndProgress` suite in `tests/browser/inertia-feature-tour.ts`.
The server side of each is ordinary Nest code.

## Typed server actions

`@nestvexa/actions` generates React hooks (`createActionHooks`) from the server's `@ActionGroup`
classes. The example runs the codegen before its build
(`scripts/codegen.mjs`, `targets: ['react']`, output in the git-ignored
`client/generated/`) and `/features/actions` calls `notes.add`
(`src/actions.ts`) from an Inertia page:

```tsx
// client/actions.ts
export const actionHooks = createActionHooks(
  createActions(createActionsClient({ csrf: xsrfToken })),
);

// client/pages/Features/Actions.tsx
const add = actionHooks.useNotesAdd({
  initialData: board, // page prop
  optimistic: (current, input) => ({
    total: (current?.total ?? 0) + 1,
    latest: [input.text, ...(current?.latest ?? [])].slice(0, 5),
  }),
});
const issue = add.error?.issues.find((entry) => entry.path[0] === 'text'); // path: 'text'
// <button disabled={add.pending} onClick={() => add.run({ text })}>
```

Input, output and the validation-issue field union come from the server
method's signature; the page props are the initial data, the optimistic value
shows while the call is pending and is rolled back when the server answers
with a validation error. The CSRF token is the session's `XSRF-TOKEN` cookie
(the one the official client echoes), sent as `x-nestvexa-csrf`
(`client/actions.ts`); identity is the host session. The browser test
(`defineTypedActionsSuite` in `tests/browser/inertia-feature-tour.ts`) checks
the request, the optimistic and rolled-back states, the server-rendered
result after a reload, and that calls without the token or from another origin
get `403`. See the [server actions guide](server-actions.md).

## Client-only mode

`pnpm start:csr` runs the same build without SSR (the `ssr` option is
omitted); `mountReactInertiaApp` then mounts with `createRoot` into the empty
root. The browser test checks the document carries no server markup and that
navigation and validation work.

## Error boundaries

`mountReactInertiaApp` wraps the app in `ErrorBoundary`; the example also puts
one inside the persistent layout with `resetKey={page.url}` so navigation still
works after a page fails. React boundaries do not run on the server; the SSR
render rejects and fallback mode takes over.

## Commands

```sh
pnpm --filter @nestvexa/example-inertia-react build      # tsc, client tsc, vite build ×2
pnpm --filter @nestvexa/example-inertia-react start:ssr  # SSR process
pnpm --filter @nestvexa/example-inertia-react start      # Nest on :3106
pnpm --filter @nestvexa/example-inertia-react dev        # Vite middleware mode + HMR
```

## UI kit components

Accessible dialog, tabs, menu, toast, date picker and data table components
for React pages ship in `@nestvexa/ui/react`; they render the same markup as the
HBS helpers and reuse its keyboard module. See the
[UI kit guide](ui-kit.md#9-react-vue-and-svelte-pages).
