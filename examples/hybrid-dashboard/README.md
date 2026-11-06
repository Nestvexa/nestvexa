# Hybrid dashboard

One Handlebars page (`/hybrid`) that combines a Live component with React, Vue
and Svelte islands from `@nestvexa/islands`:

| Part          | Renderer | Behaviour                                                                                            |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Notifications | Live     | `notify` and `toggleChart` actions; the component owns the React chart island inside its own markup. |
| Revenue chart | React    | `immediate` strategy; survives Live updates of its owner and remounts once when toggled back.        |
| Activity feed | Vue      | `visible` strategy; props are escaped data, never HTML.                                              |
| Status widget | Svelte   | `idle` strategy.                                                                                     |
| Broken island | custom   | Its loader rejects on purpose; the fallback text stays and the other islands keep working.           |

The server keeps an `IslandRegistry` allowlist (id, framework, strategy); the
browser bundle (`client/islands.ts`, built with esbuild and the official Svelte
compiler by `build-client.mjs`) holds the matching module map. Each framework is
a separate, lazily loaded, content-hashed chunk served from `/islands/chunks/`.
`client/track.ts` records mount/unmount events for the browser tests only.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm build                     # tsc + build-client.mjs
pnpm --filter @nestvexa/example-hybrid-dashboard start   # http://127.0.0.1:3112/hybrid
```

`PORT` overrides the port.

## Tests

The root Playwright suite starts this example on port **3112**
(`tests/browser/islands.spec.ts`): independent mounts that survive Live
updates, remove/reinsert cleanup, failure isolation and an axe scan. The
`/hybrid` route of [`integration-matrix`](../integration-matrix/README.md)
shows the same pattern next to every other rendering mode, plus a universal
server action.

## Security notes

- Island props are serialized as JSON data; markup in props renders as text.
- Only allowlisted island ids render; unknown ids are rejected on the server.
- Chunk requests accept only the content-hashed names the build produced.
- The CSP is `script-src 'self'`; `style-src` allows `'unsafe-inline'` because
  the Svelte widget is compiled with injected component CSS.
- The guest `express-session` identity uses the in-memory store and a
  per-process secret: demonstration only.
