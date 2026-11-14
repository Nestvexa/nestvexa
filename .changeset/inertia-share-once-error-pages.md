---
'@nestvexa/inertia': minor
---

Add `shareOnce`: a module option (the reference middleware's `shareOnce()`)
and `InertiaService.shareOnce(request, key, callback, options?)` share once
props with every page, skipped while the official client reports them loaded.
Add error pages: the `errorPage` option renders a configured Inertia component
with the original status for 403, 404, 500 and 503 through
`InertiaErrorPageFilter`, with exception details only in `debug` mode.
