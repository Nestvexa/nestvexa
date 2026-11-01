# Inertia + Svelte example (Vite, SSR)

Nest host with `@nestvexa/inertia`, the official `@inertiajs/svelte` 3.10.0
client through `@nestvexa/svelte` (Svelte 5 `hydrate`/`mount`), a Vite 8
production build (`svelte-check` checked) and in-process server-side rendering
with `svelte/server`.

Features: persistent nested layouts with `<svelte:boundary>`, `<Link>`
navigation, `useForm` with server validation and flash, partial reload,
deferred props, shared props, typed page props, CSP nonce, an error page
(`/broken`) and asset version 409s.

```sh
pnpm --filter @nestvexa/example-inertia-svelte build
pnpm --filter @nestvexa/example-inertia-svelte start   # http://127.0.0.1:3108
pnpm --filter @nestvexa/example-inertia-svelte dev     # Vite middleware mode + HMR
```

See [the Svelte guide](../../docs/guides/svelte.md).
