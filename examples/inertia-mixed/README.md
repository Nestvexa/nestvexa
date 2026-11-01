# Mixed host: HBS + React + Vue + Svelte

One Nest backend (port 3109) serving an HBS page at `/` and three Inertia roots:
`/react`, `/vue` and `/svelte`. Each root has its own Vite config, `base`
(`/build/<root>/`), manifest, asset version (`<root>:<hash>`) and in-process SSR
bundle. Navigation inside a root is an Inertia XHR visit; an Inertia `<Link>`
into another root receives `409` + `X-Inertia-Location` and the official client
performs a full page load. Bundles never mix (asserted on the manifests and the
network in `tests/browser/inertia-mixed.spec.ts`).

```sh
pnpm --filter @nestvexa/example-inertia-mixed build   # 3 type checks + 6 Vite builds
pnpm --filter @nestvexa/example-inertia-mixed start   # http://127.0.0.1:3109
```
