---
'nestvexa': minor
---

Add `registerViewEngine(app, extension, engine)`: render `@Render('<view>.<extension>')` with another adapter (EJS, Pug, Nunjucks) next to Handlebars on Express (`app.engine`) and Fastify (the `reply.view` decorator dispatches by extension).
