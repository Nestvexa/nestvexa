---
'@nestvexa/observability': minor
---

Devtools: add `DevtoolsModule.registerAsync` and the structural `kernel` option, which adds
kernel security policies, capabilities and diagnostics to the panel and `data.json`
(`kernel` field). The panel now registers on Fastify (the catch-all route that Fastify
rejected is removed; unknown paths keep answering 404).
