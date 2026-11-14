---
'@nestvexa/islands': patch
---

`svelteIsland` and `svelteIslandRenderer` accept Svelte components with
required props, including a typed `island: IslandContext` prop, like
`reactIsland`. Previously `svelte-check` rejected such components because the
parameter was typed `Component<Record<string, unknown>>`.
