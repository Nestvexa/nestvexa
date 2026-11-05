---
'@nestvexa/observability': minor
---

Add `DevErrorFilter`: a development-only error page with the failing template
`file:line` (HBS, EJS, Pug, Nunjucks), an excerpt and clickable editor links for
template and application stack frames. Construction is refused in production.
