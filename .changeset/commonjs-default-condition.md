---
'@nestvexa/alpine': patch
'@nestvexa/cache': patch
'@nestvexa/client': patch
'@nestvexa/core': patch
'@nestvexa/engine-hbs': patch
'@nestvexa/inertia': patch
'@nestvexa/live': patch
'nestvexa': patch
'@nestvexa/realtime': patch
'@nestvexa/views': patch
---

Add a `default` export condition so CommonJS Nest applications on Node 22.12+ can
load the ESM packages through `require()`. Packages remain ESM-only.
