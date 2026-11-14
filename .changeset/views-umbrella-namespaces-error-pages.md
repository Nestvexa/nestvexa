---
'@nestvexa/core': minor
'nestvexa': minor
---

Add `views.namespaces` and `views.themes` (validated name -> directory maps) to
the core configuration. The umbrella passes them to its Handlebars engine,
resolves `@Render('admin::page')` on Express through a namespaced `view` class,
and accepts `configureNestvexa(app, { errorPages })` to install the opt-in
`ViewErrorPageFilter` rendered by its own engine.
