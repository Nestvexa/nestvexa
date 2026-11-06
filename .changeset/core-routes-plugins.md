---
'@nestvexa/core': minor
---

Add a typed route map generator (`collectRoutes`, `moduleControllers`,
`generateRouteModule`, `buildPath`, `@RouteName`) that reads Nest controller
metadata at build time, and a minimal explicit plugin registry contract
(`PluginRegistry`, `definePlugin`, `parsePluginManifest`, `satisfiesVersion`).
