---
'@nestvexa/inertia': minor
---

Add the development-only `inspector` option: each page response's component,
kind, status, resolved props and partial, deferred and shared prop names are
passed to a structural `page()` hook such as `DevtoolsInspector` from
`@nestvexa/observability`. A failing inspector never changes the response.
