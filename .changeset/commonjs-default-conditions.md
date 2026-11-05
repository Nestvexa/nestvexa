---
'@nestvexa/actions': patch
'@nestvexa/ai': patch
'@nestvexa/engine-ejs': patch
'@nestvexa/engine-nunjucks': patch
'@nestvexa/engine-pug': patch
'@nestvexa/flags': patch
'@nestvexa/forms': patch
'@nestvexa/i18n': patch
'@nestvexa/offline': patch
'@nestvexa/react': patch
'@nestvexa/svelte': patch
'@nestvexa/ui': patch
'@nestvexa/uploads': patch
'@nestvexa/vite': patch
'@nestvexa/vue': patch
---

Every export entry now declares a `default` condition, so CommonJS Nest apps can
load these packages with `require()` (Node 22.12+ `require(esm)`), matching the
other packages.
