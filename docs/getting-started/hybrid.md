# Getting started: hybrid pages and islands

A hybrid page is a server-rendered HBS page that combines Live components with
small, allowlisted React, Vue or Svelte **islands**. Each piece owns an explicit
part of the DOM. This page follows the
[hybrid dashboard example](../../examples/hybrid-dashboard/src/main.ts): a Live
notifications component that owns a React chart, plus independent Vue and Svelte
islands on the same page.

## DOM ownership rules

> **Warning:** Two runtimes must never patch the same DOM. Nestvexa enforces one
> owner per subtree; it does not support arbitrary shared ownership between Live,
> Alpine and a framework.

- An island root (`data-nv-island`) belongs to its framework. Live morphs keep the
  island root and never patch inside it; Alpine must not run inside it.
- Alpine-owned markup inside a Live component sits in an `nv:ignore` subtree.
- A Live child component is its own root with its own state and revision; the
  parent re-render leaves browser-owned child DOM alone.
- Islands receive props once at mount. Later changes travel through the island
  event bridge or a new mount, never through a shared mutable object.
- Navigating between incompatible client roots is a full page load.

The decision record is [ADR 0004](../adr/0004-renderers-and-islands.md).

## 1. Install

```sh
npm install nestvexa @nestvexa/islands
npm install react react-dom vue svelte   # only the frameworks you use
```

Framework packages are optional peers of `@nestvexa/islands`. Bundle the browser
side with your own bundler; the example uses esbuild with code splitting so each
framework is a separate lazily loaded chunk.

## 2. Declare the server allowlist

<!-- snippet: examples/hybrid-dashboard/src/main.ts -->

```ts
const islands = new IslandRegistry([
  { id: 'revenue-chart', framework: 'react', strategy: 'immediate' },
  { id: 'activity-feed', framework: 'vue', strategy: 'visible' },
  { id: 'status-widget', framework: 'svelte', strategy: 'idle' },
  { id: 'broken-island', framework: 'custom', strategy: 'immediate' },
]);
```

`islands.render(id, props, options)` returns trusted `SafeHtml` with escaped,
size-bounded JSON props and an optional fallback. Unknown ids throw. In HBS you
can also use the `nvIsland` helper from `registry.helpers()`.

## 3. Mix a Live component and an island

The Live component renders the React island inside its own template. Because the
island root is an ownership boundary, Live updates to `count` keep the chart's
React state; toggling `showChart` removes and later re-mounts it.

<!-- snippet: examples/hybrid-dashboard/src/main.ts -->

```ts
@LiveComponent({ name: 'notifications', view: 'notifications' })
class Notifications {
  @State() count = 0;
  @State() showChart = true;
  @Computed() get chartIsland(): string {
    // Rendered as trusted markup through a triple-stash in this view only.
    return islands.render(
      'revenue-chart',
      { title: 'Revenue by quarter', values: [12, 19, 7, 15] },
      {
        key: 'chart',
        label: 'Revenue chart (React)',
        fallback: 'Loading chart…',
      },
    ).value;
  }
  @Action() notify(): void {
    this.count++;
  }
  @Action() toggleChart(): void {
    this.showChart = !this.showChart;
  }
}
```

The page controller mounts the Live component and renders the other islands as
ordinary view-model values, registered through
`NestvexaModule.forRoot(..., { components: [Notifications], useFactory })` exactly
as in [Live](live.md#3-register-it-with-host-policies).

## 4. Start the browser loader

The browser holds the matching build-time module map; markup can only select ids
present in it.

<!-- snippet: examples/hybrid-dashboard/client/islands.ts -->

```ts
const loader = createIslands({
  modules: {
    'revenue-chart': () =>
      import('./react-chart.js').then((module) => module.default),
    'activity-feed': () =>
      import('./vue-feed.js').then((module) => module.default),
    'status-widget': () =>
      import('./svelte-widget.js').then((module) => module.default),
    'broken-island': () => Promise.reject(new Error('Demonstration failure')),
  },
  onError: (_error, element) => {
    element.setAttribute('data-nv-island-failed', '');
  },
});
loader.start();
```

Each island module wraps a component with `reactIsland`, `vueIsland` or
`svelteIsland` from `@nestvexa/islands/react|vue|svelte`. Strategies are
`immediate`, `visible`, `idle` and `interaction`. A failing loader marks only that
root as failed and keeps its fallback.

## 5. Run and test

```sh
pnpm build
pnpm --filter @nestvexa/example-hybrid-dashboard start   # http://127.0.0.1:3112/hybrid
```

The [islands browser spec](../../tests/browser/islands.spec.ts) covers independent
mounts, retention across Live updates, removal and reinsertion, the event bridge,
separate framework chunks, error fallback and axe checks.

## Security

Islands are trusted code chosen at build time. Props are public: never put
secrets in them. Any island interaction that changes server data must go through
an authorized Live action, a [server action](api.md) or your own guarded route.

## Nested Live components instead of islands

When the widget does not need a client framework, prefer a nested Live
component: `children: { member: TeamMember }` on the parent and
`{{nvChild 'member' id name=name}}` in its template. See
[nested components](../guides/nested-components.md) for props, `@Reactive`,
`@Modelable`, events and lazy children.

> **Known gap:** Islands have no server-side rendering (only a trusted fallback;
> React hydrates when you supply `data-nv-ssr` markup yourself), no signed
> server props, no `noscript` handling, no shared theme/context or typed action
> client for islands, and no islands bundle budget. The `interaction` strategy and
> some event-bridge limits are untested. Islands are bundled with esbuild in the
> example, not through `@nestvexa/vite`.
