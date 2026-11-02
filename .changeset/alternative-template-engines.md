---
'@nestvexa/views': minor
'@nestvexa/engine-ejs': minor
'@nestvexa/engine-pug': minor
'@nestvexa/engine-nunjucks': minor
---

Add optional EJS (7.0.2), Pug (3.0.4) and Nunjucks (3.2.4) view engine
adapters. Each escapes by default, renders framework `SafeHtml` (Live mounts,
slots, layout bodies) through its escaped syntax, restricts views and
template-authored includes to the configured root with HBS-equivalent
validation and real-path checks, caches per instance in production, reloads in
development and reports template name/line in development errors. Pug rejects
render-time partial alias maps and unregistered filters; Nunjucks keeps
autoescaping always on. `@nestvexa/views` gains a public adapter kit
(`TemplateRoot`, `normalizeViewId`, `resolveTemplateReference`,
`copyViewModel`, `assertViewAliases`, `invokeViewHelper`, `expressViewModel`),
validates adapter shape at registration and adds `requireAll()` with startup
errors that name missing and declared capabilities. The umbrella remains
HBS-only and does not depend on the new adapters.
