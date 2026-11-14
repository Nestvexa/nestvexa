---
'@nestvexa/core': minor
---

Add `emitDeprecation(code, message)` and the `NESTVEXA_DEPRECATIONS` code table: a Node `DeprecationWarning` emitted once per stable code per process that honours `--no-deprecation`, `--trace-deprecation` and `--throw-deprecation`. The deprecated `definePlugin()` (`NVDEP001`) and `new PluginRegistry()` (`NVDEP002`) now warn; `pluginExtension` and `registry.extensions()` do not.
