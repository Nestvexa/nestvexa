---
'@nestvexa/core': minor
---

Unify the extension API on `NestvexaExtension`: extensions may declare `version` and a
supported `nestvexa` range, checked against the new `NESTVEXA_VERSION` at startup. The
legacy `PluginRegistry` and `definePlugin` are deprecated adapters: convert a plugin with
`pluginExtension(plugin)` or pass `registry.extensions()` to
`CoreModule.forRoot(options, { extensions })` (migration notes in the core README).
CSRF policies receive the already-resolved identity as `verify(request, subject?)`.
