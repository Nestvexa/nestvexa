---
'@nestvexa/cli': minor
---

`nestvexa add react|vue|svelte` now scaffolds an SSR entry per Inertia root
(`client/<fw>/ssr.ts[x]`), builds it with `build:<fw>` to
`dist/<fw>/ssr/ssr.js`, and the generated `inertia.config.ts` renders pages
in-process from that bundle in production with client-rendered fallback.
