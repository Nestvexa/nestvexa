# Inertia + Svelte example (Vite, SSR)

Nest host with `@nestvexa/inertia`, the official `@inertiajs/svelte` 3.10.0
client through `@nestvexa/svelte` (Svelte 5 `hydrate`/`mount`), a Vite 8
production build (`svelte-check` checked) and in-process server-side rendering
with `svelte/server`.

Features: persistent nested layouts with `<svelte:boundary>`, `<Link>`
navigation, `useForm` with server validation and flash, partial reload,
deferred props, shared props, typed page props, CSP nonce, an error page
(`/broken`) and asset version 409s.

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
pnpm --filter @nestvexa/example-inertia-svelte build
pnpm --filter @nestvexa/example-inertia-svelte start   # http://127.0.0.1:3108
pnpm --filter @nestvexa/example-inertia-svelte dev     # Vite middleware mode + HMR
```

See [the Svelte guide](../../docs/guides/svelte.md).
