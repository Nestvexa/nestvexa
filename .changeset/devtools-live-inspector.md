---
'@nestvexa/observability': minor
'@nestvexa/live': minor
'nestvexa': minor
---

Development devtools panel with a Live inspector: `DevtoolsInspector` (Live's new
`inspector` option) records the registered component catalog and each top-level
render's redacted public state, re-render cause and form errors; `DevtoolsModule`
renders them with actions, lifecycle hooks, CSRF/authorization errors, requests,
realtime, jobs and renderer counts in a script-free page under a
`default-src 'none'` CSP, and serves the versioned `data.json` contract
(`nestvexa-devtools/1`). Production is refused by the module, the inspector and
per request. `LiveRuntime.describeComponents()` returns the catalog.
