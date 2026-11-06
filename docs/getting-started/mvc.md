# Getting started: MVC

MVC mode is ordinary NestJS rendering: a controller method returns a view model,
Nest's `@Render()` selects a template and Nestvexa renders it with Handlebars
(HBS) through a layout. No browser runtime is loaded unless you add one.

## 1. Install

```sh
npm install nestvexa
```

`nestvexa` depends on `@nestvexa/core`, `@nestvexa/views` and
`@nestvexa/engine-hbs` (Handlebars 4.7.10). Nest 12, `reflect-metadata` and RxJS
are peers you already have.

## 2. Register the module and render a page

This is the complete, tested [HBS starter](../../examples/starter-hbs/src/main.ts).
The controller uses only standard Nest decorators:

<!-- snippet: examples/starter-hbs/src/main.ts -->

```ts
@Controller()
class HomeController {
  @Get()
  @Render('home')
  home() {
    return {
      title: 'Nestvexa',
      message: 'Build full-stack. Stay in Nest.',
      example: '<script>alert("escaped")</script>',
    };
  }

  @Get('about')
  @Render('about')
  about() {
    return { title: 'About Nestvexa' };
  }

  @Get('api/health')
  health() {
    return { status: 'ok', renderer: 'native-nest' };
  }
}
```

`NestvexaModule.forRoot()` configures the view root and default layout, and
`configureNestvexa(app)` installs the engine on the HTTP platform before
`listen()`:

<!-- snippet: examples/starter-hbs/src/main.ts -->

```ts
@Module({
  imports: [
    NestvexaModule.forRoot({
      views: {
        root: fileURLToPath(new URL('../views', import.meta.url)),
        layout: 'layouts/main',
      },
    }),
  ],
  controllers: [HomeController],
})
class AppModule {}
```

<!-- snippet: examples/starter-hbs/src/main.ts -->

```ts
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await configureNestvexa(app);
app.enableShutdownHooks();
```

## 3. Write the templates

`views/layouts/main.hbs` wraps every page; the rendered page arrives as `body`,
which is trusted framework output:

```hbs
<html lang='en'>
  <head><title>{{title}}</title></head>
  <body><main>{{{body}}}</main></body>
</html>
```

`views/home.hbs`:

```hbs
<h1>{{title}}</h1>
<p>{{message}}</p>
<pre>{{example}}</pre>
```

`{{value}}` escapes HTML, so the `<script>` string above is shown as text. Triple
braces bypass escaping: use them only for trusted markup such as the layout body.
Escaping is not URL or script-context sanitization; see the
[template engine guide](../guides/template-engines.md#escaping-and-the-trusted-path).

## 4. Run it

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @nestvexa/example-starter-hbs start   # http://127.0.0.1:3100
```

`/`, `/about` and the untouched JSON route `/api/health` are covered by the
[MVC browser spec](../../tests/browser/mvc.spec.ts) and the
[integration suite](../../tests/integration.test.ts).

## Options and defaults

| Option         | Default     | Notes                                                                  |
| -------------- | ----------- | ---------------------------------------------------------------------- |
| `views.root`   | `src/views` | Operating-system path; view IDs use forward slashes and stay inside it |
| `views.layout` | none        | Layout view ID, for example `layouts/main`                             |
| `views.cache`  | `false`     | Set `true` in production for immutable deployed templates              |
| `views.engine` | `hbs`       | The umbrella only accepts `hbs`; other engines are registered directly |

Use `NestvexaModule.forRootAsync({ imports, inject, useFactory })` when options
come from `ConfigService`. Helpers from optional packages are added with
`app.get(HbsEngine).registerHelpers(...)` before `configureNestvexa(app)`; see the
[engine-hbs README](../../packages/engine-hbs/README.md).

## Another template engine

EJS, Pug and Nunjucks are separate adapters (`npm install @nestvexa/engine-ejs`,
`@nestvexa/engine-pug` or `@nestvexa/engine-nunjucks`). They are registered with
the HTTP platform directly instead of through `NestvexaModule.forRoot()`; the
[template engine guide](../guides/template-engines.md#wiring-an-engine-into-nest-mvc)
shows the Express and Fastify wiring and each engine's declared capabilities.
The [custom engine example](../../examples/custom-engine/README.md) shows a
third-party adapter.

## Alpine for local interactions

MVC pages can use Alpine for purely local behavior. The umbrella ships the
Alpine CSP build as a hosted asset (`nestvexa/assets`); when you also enable Live,
`{{nvScripts}}` starts Alpine and the Live client together. See the
[client asset guide](../guides/client-assets.md) and [Live](live.md).

> **Known gap:** The umbrella HBS configuration has no partial map, namespaced
> views (`admin::page`), nested HBS layouts, URL-generation or permission helpers,
> themes, or view-rendered error pages. Partials work when you construct
> `HbsEngine` yourself with `partials`; production 404/500 pages need your own
> Nest exception filter.
