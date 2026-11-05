# Islands and hybrid pages

Allowlisted React, Vue and Svelte **islands** inside Nestvexa HBS and Live pages, with
explicit DOM ownership: the framework owns its island root, Live and Alpine never
patch inside it, and Live morphs retain island roots. Optional; not part of the
default `nestvexa` install.

## Install

```sh
npm install @nestvexa/islands
# plus the frameworks you use (optional peers)
npm install react react-dom   # and/or vue, svelte
```

Node 22.13+ or 24 on the server. Browser bundles are built with your bundler (the
example uses esbuild with code splitting).

## Server: registry and markup

```ts
import { IslandRegistry } from '@nestvexa/islands';

export const islands = new IslandRegistry([
  { id: 'revenue-chart', framework: 'react', strategy: 'immediate' },
  { id: 'activity-feed', framework: 'vue' }, // strategy defaults to 'visible'
  { id: 'status-widget', framework: 'svelte', strategy: 'idle' },
]);

// In a controller view model (trusted SafeHtml):
islands.render(
  'revenue-chart',
  { title: 'Revenue', values: [12, 19] },
  {
    key: 'chart',
    label: 'Revenue chart',
    fallback: 'Loading chart…',
  },
);
```

`registry.helpers()` returns an `nvIsland` template helper
(`{{nvIsland "activity-feed" key="feed" items=items}}` in Handlebars). Props are plain
JSON (no functions, dates, BigInt, cycles or prototype keys), bounded (default
32 KiB) and HTML-escaped into `data-nv-props`. Unknown ids throw.

## Browser: loader and adapters

```ts
import { createIslands } from '@nestvexa/islands/client';

createIslands({
  modules: {
    'revenue-chart': () => import('./react-chart.js').then((m) => m.default),
    'activity-feed': () => import('./vue-feed.js').then((m) => m.default),
    'status-widget': () => import('./svelte-widget.js').then((m) => m.default),
  },
}).start();
```

```ts
import { reactIsland } from '@nestvexa/islands/react'; // export default reactIsland(Chart)
import { vueIsland } from '@nestvexa/islands/vue';
import { svelteIsland } from '@nestvexa/islands/svelte';
```

- **Allowlist:** markup can only select ids present in the build-time `modules` map.
- **Strategies:** `immediate`, `visible` (IntersectionObserver), `idle`
  (`requestIdleCallback`), `interaction` (pointer, focus, key or hover).
- **Lifecycle:** a MutationObserver unmounts removed islands (aborting
  `context.signal`, removing listeners) and mounts inserted ones exactly once.
  Nested islands inside another island are ignored.
- **Errors:** a failing loader or mount marks the root `data-nv-island-error` and
  keeps the fallback; other islands are unaffected.
- **Event bridge:** `context.emit(name, detail)` / `context.on(name, handler)` use
  namespaced `island:<name>` document events with cloned details and at most 32
  listeners per island, removed automatically on unmount.
- React islands hydrate when the root has `data-nv-ssr`; otherwise they mount.

## Live interplay

Live morphs treat `data-nv-island` roots as ownership boundaries: a parent Live
re-render keeps the island DOM and framework state. Removing the island markup in a
Live render unmounts it; re-adding mounts a fresh instance. Props are read at mount
time; use events to communicate later changes. Every island interaction that
changes server data must go through an authorized Live action, a Nestvexa action or
your own guarded route.

## Security

Islands are trusted application code chosen at build time. Props are public data:
never put secrets in them. Server-rendered fallback HTML must be trusted
(`SafeHtml`) or plain text (escaped).

## Testing

```sh
pnpm build && pnpm vitest run tests/islands.test.ts
pnpm exec playwright test tests/browser/islands.spec.ts
```

The [hybrid dashboard example](../../examples/hybrid-dashboard/src/main.ts) mounts React,
Vue and Svelte islands next to a Live component that owns a React island. Its
browser tests cover independent mounts, retention across Live updates, removal and
reinsertion, the event bridge, separate framework chunks, error fallback and axe
checks. Package: [@nestvexa/islands](../../packages/islands/README.md).

## CLI

`nestvexa add islands` generates the server registry, the client allowlist, `vite.islands.config.ts` and static serving; `nestvexa make:island <Name> --renderer react|vue|svelte` adds the component and both registry entries. See the [CLI reference](../reference/cli.md).
