# Inertia + Vue example (Vite, SSR)

Nest host with `@nestvexa/inertia`, the official `@inertiajs/vue3` 3.10.0
client through `@nestvexa/vue`, a Vite 8 production build (`vue-tsc` checked)
and in-process server-side rendering of the built SSR bundle.

Features: persistent nested layouts, `<Link>` navigation, `useForm` with server
validation and flash, partial reload, deferred props, shared props, typed page
props, CSP nonce, an error boundary page (`/broken`) and asset version 409s.

`/documents` combines `@nestvexa/forms` and `@nestvexa/uploads` with the
official `useForm` (`src/documents.ts`): the file is uploaded through
`@nestvexa/uploads/browser` with a progress bar, the form submits the returned
token as JSON, Precognition validates title and token with the same forms
schema, and upload, field and form-level (`_form`) failures appear as `useForm`
errors. Tested by `tests/browser/inertia-forms-uploads.ts`.

With `--test-controls` (`start:e2e`, `start:csr`), `/__test/hostile` serves
hostile page props (`src/hostile.ts`): script, event-handler, attribute-breakout,
template-syntax and `javascript:`/`data:` URL payloads. The page renders them as
text and attribute values and binds links through a scheme allowlist
(`client/safe-href.ts`), because the framework escapes markup but does not filter
URL schemes. Tested by `tests/browser/inertia-hostile-props.ts` (SEC-022).

```sh
pnpm --filter @nestvexa/example-inertia-vue build
pnpm --filter @nestvexa/example-inertia-vue start   # http://127.0.0.1:3107
pnpm --filter @nestvexa/example-inertia-vue dev     # Vite middleware mode + HMR
```

See [the Vue guide](../../docs/guides/vue.md).
