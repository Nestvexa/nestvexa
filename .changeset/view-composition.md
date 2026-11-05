---
'@nestvexa/views': minor
'@nestvexa/engine-hbs': minor
'@nestvexa/engine-ejs': minor
'@nestvexa/engine-pug': minor
'@nestvexa/engine-nunjucks': minor
---

Add namespaced views (`admin::users/index`) with application vendor overrides,
per-render theme override directories (`RenderOptions.theme`) for every
first-party adapter, and HBS layout inheritance through a leading
`{{!< parent}}` directive (also kept in precompiled modules). HBS gains a
`debug` option (default `!cache`) whose errors name the failing template and
line for parse errors, helper exceptions, missing helpers and missing
partials. `@nestvexa/views` adds engine-neutral helpers (`route` over a
`RouteTable` or Nest controller metadata, `pageTitle`/`metaTags`, fail-closed
`can`/`cannot` and `grantPermissions`, `assetTags` over the
`ViewAssetProvider` interface) and view-rendered error pages
(`ViewErrorPageFilter`, `renderErrorPage`) with an escaped development page.
