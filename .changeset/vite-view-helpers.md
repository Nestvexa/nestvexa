---
'@nestvexa/vite': minor
---

Add `viteViewHelpers(assets)`: a trusted `viteTags` view helper for
server-rendered HBS/Live pages (and EJS/Pug/Nunjucks) that prints an app's
Vite manifest tags — CSP nonce meta, stylesheets, module preloads and entry
scripts — with the request nonce. `@nestvexa/vite` now depends on the
renderer-neutral `@nestvexa/views` contract for `SafeHtml`.
