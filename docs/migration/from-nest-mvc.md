# Migrating from plain Nest MVC

This guide moves an application that follows the
[Nest MVC recipe](https://docs.nestjs.com/techniques/mvc) (the `hbs` package with
`app.setViewEngine('hbs')`, or `@fastify/view`) onto Nestvexa. Controllers do not
change: `@Get()` plus `@Render('view')` keeps working, and so do guards, pipes,
interceptors, filters, sessions and request-scoped providers.

## What changes

| Plain Nest MVC                                          | Nestvexa                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm install hbs`                                       | `npm install nestvexa` (Handlebars 4.7.10 through `@nestvexa/engine-hbs`)               |
| `app.setBaseViewsDir(dir)` / `app.setViewEngine('hbs')` | `NestvexaModule.forRoot({ views: { root: dir } })` + `await configureNestvexa(app)`     |
| `hbs` `layout.hbs` / `{{{body}}}`                       | `views.layout: 'layouts/main'`; the body is trusted `SafeHtml`                          |
| `hbs.registerHelper(name, fn)`                          | `app.get(HbsEngine).registerHelpers({ name: fn })` before `configureNestvexa`           |
| `hbs.registerPartials(dir)`                             | `new HbsEngine({ partials: { alias: 'partials/x' } })`, see below                       |
| One global Handlebars instance                          | One isolated engine per application; prototype access and missing-helper calls disabled |
| `@fastify/view` with `reply.view`                       | `configureNestvexa(app)` decorates `reply.view` on Fastify                              |
| Any value in the view model                             | Finite JSON values and `SafeHtml` only; entities, Dates, class instances are rejected   |

## Step by step

1. Install `nestvexa` and remove `hbs` (or `@fastify/view`) from your bootstrap.
2. Move the view directory option into the module:

   ```ts
   @Module({
     imports: [
       NestvexaModule.forRoot({
         views: {
           root: join(__dirname, '..', 'views'),
           layout: 'layouts/main',
         },
       }),
     ],
     controllers: [AppController],
   })
   export class AppModule {}
   ```

3. In `main.ts`, replace the view-engine calls with `await configureNestvexa(app)`
   before `app.listen()`. Keep your existing session, helmet and static-file
   setup.
4. Map view models to plain data. Format dates and money in the controller
   (or a helper) and convert ORM entities into DTOs: the engine rejects class
   instances, functions, getters, cycles and more than 32 levels or 10,000
   values so that templates cannot reach services or prototypes.
5. Turn on `views.cache: true` for production deployments and call
   `HbsEngine.clearCache()` only when templates change in place.
6. Optionally run `npx nestvexa doctor` to check Node/Nest versions, the
   `configureNestvexa` call and `{{nvScripts}}` placement
   ([CLI reference](../reference/cli.md)).

`NestvexaModule.forRootAsync({ imports, inject, useFactory })` accepts the same
options from `ConfigService`. CommonJS projects can keep CommonJS: Node 22.12+
loads the ESM packages through `require(esm)`.

## Escaping rules stay strict

`{{value}}` escapes, `{{{value}}}` does not. Existing templates that use triple
braces for user-provided content must switch to double braces. Framework output
(layout `body`, `LiveRuntime.mount()` results, island markup) is `SafeHtml` and
renders correctly through double braces. See
[template engines](../guides/template-engines.md#escaping-and-the-trusted-path).

## Partials and layouts

The umbrella creates its `HbsEngine` from `views.root`, `views.layout` and
`views.cache` only. If your templates rely on `{{> partial}}`, construct
`HbsEngine` yourself with a `partials` alias map and register it with the HTTP
platform the way the [template engine guide](../guides/template-engines.md#wiring-an-engine-into-nest-mvc)
shows for other adapters, or replace partials with helpers that return
`SafeHtml`. Nested layouts are composed explicitly by rendering one view inside
another.

## Adding interactivity afterwards

Once pages render through Nestvexa you can opt in per page:

- [Live components](../getting-started/live.md) for server-driven widgets
  (requires a session and an identity/authorization policy);
- Alpine through the bundled CSP build ([client assets](../guides/client-assets.md));
- [islands](../getting-started/hybrid.md) for isolated React/Vue/Svelte widgets;
- [Inertia](../getting-started/inertia.md) for whole pages in a client framework.

## Verify

```sh
pnpm exec vitest run tests/integration.test.ts tests/views.test.ts
```

Those suites boot real Express and Fastify Nest applications, render through
layouts, check escaping and the untouched API routes. Run your own e2e tests
against every migrated page, especially pages that previously printed raw HTML.

> **Known gap:** There is no automated codemod from `hbs` to Nestvexa, no
> namespaced views, no URL-generation, permission or page-metadata helpers, no
> themes and no view-rendered error pages. The HBS engine has no development
> debug mode: errors name the view, and the template line is only in the
> retained `cause`.
