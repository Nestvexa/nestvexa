# Inertia + React example (Vite, SSR)

Nest host with `@nestvexa/inertia`, the official `@inertiajs/react` 3.10.0
client through `@nestvexa/react`, a Vite 8 production build and server-side
rendering by the official Inertia SSR server process.

Features: persistent nested layouts (`AppLayout` > `UsersLayout`), `<Link>`
navigation, `useForm` with server validation errors and flash after redirect,
file upload with server validation, partial reload (`only: ['extra']`), deferred
props, shared props, typed page props (`src/page-types.ts`), CSP with a
per-request nonce, an error boundary page (`/broken`, SSR fallback) and asset
version 409s.

`/features` is a tour of client-owned Inertia v3 features driven by the
official client (prefetch, instant and manual visits, non-GET links, view
transitions, polling, infinite scroll and merge props, `WhenVisible`,
remembered state, once props, history encryption + `clearHistory`,
optimistic updates, Precognition with `@nestvexa/forms`, a 2.6 MB payload);
see `src/features.ts` and `tests/browser/inertia-react-features.spec.ts`.
`pnpm start:csr` serves the build with SSR disabled.

`/documents` combines `@nestvexa/forms` and `@nestvexa/uploads` with the
official `useForm` (`src/documents.ts`): the file is uploaded through
`@nestvexa/uploads/browser` with a progress bar, the form submits the returned
token as JSON, Precognition validates title and token with the same forms
schema, and upload, field and form-level (`_form`) failures appear as `useForm`
errors. Tested by `tests/browser/inertia-forms-uploads.ts`.

```sh
pnpm --filter @nestvexa/example-inertia-react build
pnpm --filter @nestvexa/example-inertia-react start:ssr   # SSR on 127.0.0.1:13716
pnpm --filter @nestvexa/example-inertia-react start       # http://127.0.0.1:3106
pnpm --filter @nestvexa/example-inertia-react dev         # Vite middleware mode + HMR, in-process SSR
```

Without the SSR process the host still works: fallback mode serves the
client-rendered document. See [the React guide](../../docs/guides/react.md).
