# Inertia + Vue example (Vite, SSR)

Nest host with `@nestvexa/inertia`, the official `@inertiajs/vue3` 3.10.0
client through `@nestvexa/vue`, a Vite 8 production build (`vue-tsc` checked)
and in-process server-side rendering of the built SSR bundle.

Features: persistent nested layouts, `<Link>` navigation, `useForm` with server
validation and flash, partial reload, deferred props, shared props, typed page
props, CSP nonce, an error boundary page (`/broken`) and asset version 409s.

```sh
pnpm --filter @nestvexa/example-inertia-vue build
pnpm --filter @nestvexa/example-inertia-vue start   # http://127.0.0.1:3107
pnpm --filter @nestvexa/example-inertia-vue dev     # Vite middleware mode + HMR
```

See [the Vue guide](../../docs/guides/vue.md).
