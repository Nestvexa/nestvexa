---
'nestvexa': minor
'@nestvexa/observability': minor
---

The umbrella registers Live (feature `live`) and its shared HBS renderer (feature `views`,
capabilities `views.hbs.*`) in `NestvexaRegistry`, and `kernelIdentity: true` in the Live
registration passes `RequestContextFactory` as Live's kernel identity. Devtools lists
installed features and plugins with `kernel.features` (`NestvexaRegistry`).

Migration: `FeatureCapabilityRegistry.report()` and the devtools capability list now include
`live.*` and `views.hbs.*` entries. An extension that declares a capability with one of
those names fails startup with `DUPLICATE_REGISTRATION`; rename it.
