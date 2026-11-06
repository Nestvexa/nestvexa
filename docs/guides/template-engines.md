# Template engines

Nestvexa renders MVC pages and Live component templates through the `ViewEngineAdapter` contract from `@nestvexa/views`. Handlebars is the default and ships with the `nestvexa` umbrella. EJS, Pug and Nunjucks are separately installed, independently tested adapters; any other engine can be plugged in through the same public contract.

| Package                     | Engine            | Extension | Install                              |
| --------------------------- | ----------------- | --------- | ------------------------------------ |
| `@nestvexa/engine-hbs`      | Handlebars 4.7.10 | `.hbs`    | Included in `nestvexa` (default)     |
| `@nestvexa/engine-ejs`      | EJS 7.0.2         | `.ejs`    | `pnpm add @nestvexa/engine-ejs`      |
| `@nestvexa/engine-pug`      | Pug 3.0.4         | `.pug`    | `pnpm add @nestvexa/engine-pug`      |
| `@nestvexa/engine-nunjucks` | Nunjucks 3.2.4    | `.njk`    | `pnpm add @nestvexa/engine-nunjucks` |

(npm and yarn work the same way after owner-authorized publication.) The umbrella does not depend on the optional adapters, so an HBS-only application never downloads EJS, Pug or Nunjucks.

## Capabilities

| Capability         | HBS | EJS                      | Pug                                                           | Nunjucks                                | Custom example (`tokens`) |
| ------------------ | --- | ------------------------ | ------------------------------------------------------------- | --------------------------------------- | ------------------------- |
| `layouts`          | yes | yes (adapter layout)     | yes (native `extends` + adapter layout)                       | yes (native `extends` + adapter layout) | yes                       |
| `partials`         | yes | yes (`include`, aliases) | yes (compile-time `include`/mixins; no render-time alias map) | yes (`include`/`import`, aliases)       | **no**                    |
| `slots`            | yes | yes                      | yes                                                           | yes                                     | yes                       |
| `asyncComposition` | yes | yes                      | yes                                                           | yes                                     | yes                       |
| `streaming`        | no  | no                       | no                                                            | no                                      | no                        |
| `precompilation`   | yes | no                       | no                                                            | no                                      | no                        |
| `safeHtml`         | yes | yes                      | yes (text output only)                                        | yes                                     | yes                       |
| `viewComposers`    | yes | yes                      | yes                                                           | yes                                     | yes                       |

`asyncComposition` and `viewComposers` are provided by `ViewEngineRegistry.render(...)`, which awaits request-aware composers before the synchronous engine render. No adapter supports async helpers/filters or HTML streaming; they say so instead of emulating it.

Fail at startup instead of at the first request when a feature depends on a capability:

```ts
const views = new ViewEngineRegistry();
views.register(engine);
views.requireAll(engine.name, ['layouts', 'partials', 'safeHtml']);
// ViewError UNSUPPORTED_CAPABILITY:
// "Engine pug does not support precompilation. Declared capabilities: layouts, partials, ..."
```

`register()` also rejects malformed third-party adapters (missing boolean capability flags, invalid extensions, missing lifecycle methods) with one error listing every problem.

## Escaping and the trusted path

Every adapter escapes by default. Each engine also has a deliberate raw-output syntax that **bypasses escaping**; use it only for markup produced by trusted server code.

| Engine   | Escaped               | Raw (bypass)                     |
| -------- | --------------------- | -------------------------------- |
| HBS      | `{{ value }}`         | `{{{ value }}}`                  |
| EJS      | `<%= value %>`        | `<%- value %>`                   |
| Pug      | `= value`, `#{value}` | `!= value`, `!{value}`, `attr!=` |
| Nunjucks | `{{ value }}`         | `{{ value \| safe }}`            |

Framework output that is already trusted HTML (the `SafeHtml` returned by `LiveRuntime.mount()`, `RenderOptions.slots`, the layout `body`, helpers that return `SafeHtml`) renders through the **escaped** syntax without hand-escaping and without raw tags. Each adapter converts `SafeHtml` into an engine-private trusted representation (Handlebars `SafeString`, an EJS/Pug private wrapper recognized by the adapter's escape function, Nunjucks `SafeString`). Browser data can never reach that representation: models are copied as JSON-like data, plain objects such as `{ value: '<x>' }` stay escaped, and objects carrying functions are rejected. In Pug, attribute values are always escaped even for `SafeHtml`.

Escaping is not context-aware sanitization: it does not validate `href` schemes or make values safe inside `<script>`, `<style>` or event-handler attributes.

## Live components on any engine

`LiveModule.register({ renderer })` accepts any `ViewEngineAdapter`. The component template is written in the engine's syntax; Nestvexa and Alpine directives are plain attributes:

```ejs
<output><%= count %></output><button type="button" nv:click="increment">+</button>
```

```pug
output= count
button(type="button" nv:click="increment") +
```

```njk
<output>{{ count }}</output><button type="button" nv:click="increment">+</button>
```

The Live runtime renders components with `layout: false` and wraps the result in its own trusted root element. Real Nest Express and Fastify applications mount a counter, post an action and synchronize a model through each engine in [the integration suite](../../tests/engine-live.test.ts).

## Wiring an engine into Nest MVC

`NestvexaModule.forRoot({ views })` configures the default HBS engine only. For another adapter, register it with the HTTP platform directly; every first-party adapter exposes an Express bridge:

```ts
const engine = new EjsEngine({ root, cache: production });
await engine.initialize();
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.engine(
  'ejs',
  (
    file: string,
    options: Record<string, unknown>,
    done: (error: Error | null, html?: string) => void,
  ) => engine.renderFile(file, options, done),
);
app.setBaseViewsDir(root);
app.setViewEngine('ejs');
```

Fastify (Nest `@Render` calls `reply.view`):

```ts
const fastify = app.getHttpAdapter().getInstance();
fastify.decorateReply(
  'view',
  async function (view: string, model: Record<string, unknown>) {
    return this.type('text/html; charset=utf-8').send(
      await engine.render(view, model),
    );
  },
);
```

Dispose the engine on shutdown (`onApplicationShutdown`). Use the same instance as the Live `renderer` so MVC pages and components share one cache.

## Namespaces and themes

Every first-party adapter (and any adapter built on `TemplateRoot`) accepts the same two options:

```ts
const engine = new HbsEngine({
  root: 'src/views',
  namespaces: {
    admin: 'src/admin/views',
    billing: 'node_modules/@acme/billing/views',
  },
  themes: { dark: 'src/themes/dark', acme: 'src/themes/acme' },
});
await engine.render('admin::users/index', model, { theme: 'acme' });
```

- `admin::users/index` resolves inside the `admin` directory. Namespace names are lowercase identifiers; unknown namespaces fail with `INVALID_VIEW`. The part after `::` follows the normal view-ID rules (no `..`, absolute paths, backslashes or `:`).
- The application overrides any namespaced view by placing a file at `<root>/vendor/<namespace>/<path>` (the `vendor/` directory of the root is reserved for this).
- `RenderOptions.theme` selects a registered theme for one render. Lookup order for `x`: `<theme>/x`, `<root>/x`. For `ns::x`: `<theme>/vendor/ns/x`, `<root>/vendor/ns/x`, `<ns dir>/x`. The theme applies to the view, its layouts and every partial/include. Theme names come from host configuration (for example a tenant setting), never from a filesystem path; unknown themes fail closed.
- Real-path containment is checked against the configured directory each file was found in.

| Engine   | Namespaced includes                                    | Theme overrides of includes                               |
| -------- | ------------------------------------------------------ | --------------------------------------------------------- |
| HBS      | partial aliases may point at `ns::path`                | yes                                                       |
| EJS      | relative includes stay in the namespace; `ns::x` works | yes (`/x` is the default root)                            |
| Pug      | relative and `/x` stay in the namespace; `ns::x` works | yes (cache key includes the theme; includes compile-time) |
| Nunjucks | names are root IDs, so write `ns::path.njk`            | yes (one environment and cache per theme)                 |

HBS precompiled views support namespaced IDs; selecting a theme with precompiled views fails with `UNSUPPORTED_CAPABILITY` because there are no override directories at runtime. The custom engine example rejects `theme` the same way.

## Layout inheritance

Pug (`extends`/`block`) and Nunjucks (`{% extends %}`/`{% block %}`) have native template inheritance, and EJS composes through `include`; use those inside layouts. HBS has no native inheritance, so the HBS adapter reads a leading directive in a layout:

```hbs
{{!< layouts/base}}
<section class='admin'>{{body}}</section>
```

The layout chosen for a render (`RenderOptions.layout` or `defaultLayout`) receives the view as `body`; if that layout starts with `{{!< parent}}`, its output becomes the parent's `body`, and so on. Slots and the model are available at every level. Chains are limited to 8 layouts and cycles fail with `INVALID_VIEW`. `layout: false` still renders a bare fragment. The directive is a Handlebars comment, so it renders nothing; it is honored only in layouts. Precompiled modules record the parent of each layout.

## View helpers

`@nestvexa/views` exports engine-neutral, synchronous helpers. Register engine-wide helpers with the engine `helpers` option (or `HbsEngine.registerHelpers`), per-request helpers with `RenderOptions.helpers`. Helper arguments are normalized with `helperArguments`: Handlebars hash arguments, Nunjucks keyword arguments and plain objects (EJS/Pug) all work.

| Factory                        | Helpers                                 | Notes                                                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeHelpers(new RouteTable)` | `route(name, params?)`                  | Named routes, written by hand or read from Nest controllers with `routesFromControllers([UsersController], { prefix })` (names default to `UsersController.show`). Parameters are percent-encoded per segment; unknown routes and missing/unsafe values throw. |
| `pageMetaHelpers(options?)`    | `pageTitle(meta)`, `metaTags(meta)`     | `metaTags` returns escaped `<title>`, description, canonical (http(s) or app-relative only), robots, `og:*` and extra `<meta>` tags. `titleTemplate: '%s · Site'`, `defaultTitle`.                                                                             |
| `permissionHelpers(check)`     | `can(ability, subject?)`, `cannot(...)` | `check` is the host policy bound to the current request. Fail-closed: only a literal `true` grants; exceptions and malformed ability names deny. Per-request, so pass through `RenderOptions.helpers`.                                                         |
| `grantPermissions(check, ...)` | (view data)                             | For `@Render` routes that cannot receive per-request helpers: precompute `{ canEdit: true, canDelete: false }` in the controller.                                                                                                                              |
| `assetHelpers(provider)`       | `assetTags(name, nonce?)`               | `ViewAssetProvider` is `{ tags(name, { nonce? }): string }` returning already-escaped tags; `ViteAssets` from `@nestvexa/vite` matches it. Names are identifier-like and the nonce must look like base64.                                                      |

```hbs
<head>{{metaTags meta}}{{assetTags 'app' nonce=cspNonce}}</head>
<a href='{{route "UsersController.show" id=user.id}}'>{{user.name}}</a>
{{#if (can 'posts.edit' post)}}<button>Edit</button>{{/if}}
```

`route` returns a plain string, so the engine escapes it in the attribute. Hiding a control with `can` is presentation only: the route or action must still authorize.

## Error pages

`ViewErrorPageFilter` is a catch-all Nest exception filter (structural, `@nestvexa/views` does not import Nest):

```ts
app.useGlobalFilters(
  new ViewErrorPageFilter({
    development: process.env.NODE_ENV !== 'production',
    render: (view, model) => engine.render(view, model),
    views: {
      '404': 'errors/404',
      '5xx': 'errors/500',
      default: 'errors/error',
    },
  }),
);
```

- Requests whose `Accept` header names `text/html` get an HTML page; everything else (JSON APIs, Live and action calls) keeps Nest's default JSON body. Override with `html: (request) => boolean`.
- Production views receive only `{ status, title, message? }`; `message` is present for 4xx `HttpException` messages (which Nest treats as public). 5xx details never reach the page. If the error view itself fails, a minimal built-in page is sent.
- `development: true` shows a built-in, fully escaped page with the error chain, stacks and, for `ViewError`s from a debug-mode adapter, the failing template and line. Never enable it in production.
- 5xx errors are passed to `log` (default `console.error`). `renderErrorPage(error, options)` is the framework-neutral core.

## Shared security rules

All first-party adapters, and adapters built with the kit below, enforce the same rules as HBS:

- View IDs are root-relative forward-slash identifiers: no absolute paths, `..`/`.` segments, backslashes, drive letters, `:` streams, empty segments or NUL bytes. Real paths must stay inside the real root (symlink/junction escapes are rejected).
- Template-authored includes follow the same rules: EJS and Pug allow `/x` (root-relative) and descending relative references; Nunjucks names are always root-relative. Raw includes cannot read files outside the root, and template size limits apply to every included file.
- Models accept finite JSON values, `undefined` and `SafeHtml` only. Prototype keys, accessors (never invoked), class instances, functions, symbols, cycles, depth over 32 and more than 10,000 values are rejected.
- Engine features that would widen file access or execution are not used: EJS `renderFile` option merging and global cache, Pug's global cache and `jstransformer-*` auto-loading, Nunjucks `FileSystemLoader`/`watch` and `autoescape: false`.
- Errors are `ViewError` (`INVALID_VIEW`, `UNSAFE_MODEL`, `UNSUPPORTED_CAPABILITY`, `RENDER_FAILED`). With `debug` (default when `cache` is off) messages name the failing template and line, for example `Unable to render view: home (partials/row.hbs:2)`; production messages name only the view. HBS locates parse errors, helper and built-in helper exceptions, missing helpers and missing partials (by the line of the `{{> name}}` reference); precompiled HBS views report the template but no line for missing partials. Never send `cause` to clients.

## Writing a custom adapter

A third-party adapter implements `ViewEngineAdapter` (`name`, `extensions`, honest `capabilities`, `initialize`, `render`, `dispose`). `@nestvexa/views` exports the hardened building blocks used by the first-party adapters:

| Export                     | Purpose                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TemplateRoot`             | Validated IDs, real-path `resolve`/`resolveSync`, bounded `read`/`readSync`, `viewFromFile` for Express filenames. |
| `normalizeViewId`          | HBS-equivalent view ID validation and extension defaulting.                                                        |
| `resolveTemplateReference` | Include/extends reference resolution (`/x` root-relative, otherwise relative) with the same validation.            |
| `copyViewModel`            | Public-data-only model copy into null-prototype objects; maps `SafeHtml` through your trusted hook.                |
| `assertViewAliases`        | Helper, partial and slot name validation.                                                                          |
| `invokeViewHelper`         | Calls a synchronous helper and rejects promises/thenables.                                                         |
| `expressViewModel`         | Strips Express `settings`, `_locals` and `cache` before rendering.                                                 |

The [custom engine example](../../examples/custom-engine/README.md) is a complete adapter for a tiny `{{ path }}` language (escaped output, no raw syntax, layouts and slots, no partials) running a Live counter inside a Nest MVC page. It rejects `RenderOptions.partials`/`helpers` with `UNSUPPORTED_CAPABILITY` because it declares no such capability, and its main module performs the startup `requireAll` check. Its behavior is covered by [unit tests](../../tests/custom-engine.test.ts) and the shared [Live integration suite](../../tests/engine-live.test.ts).

Checklist for adapter authors: declare only capabilities you implement; never pass model data as engine options; keep caches per instance and clear them in `dispose()`; restrict every file the engine can load to the root; keep escaping on by default and document the raw syntax; wrap failures in `ViewError('RENDER_FAILED')` with the original `cause`.

## Not yet available

- Umbrella `NestvexaModule.forRoot({ views: { engine } })` selection of a non-HBS engine is not implemented.
- Streaming, async helpers/filters and precompilation for EJS, Pug and Nunjucks are unsupported.
- Themes with precompiled HBS views, and `/x` references that stay inside the current namespace in EJS (EJS gives the include hook no parent file), are not supported.
- `routesFromControllers` encodes neither host nor version constraints and uses only the first path of a multi-path handler.

## CLI

`nestvexa add engine ejs|pug|nunjucks` adds the adapter, `src/nestvexa/engines/<engine>.engine.ts` (registered for Express in `main.ts`) and `views/layouts/main.<ext>`; `nestvexa make:page <Name> --renderer <engine>` generates a controller rendering `views/pages/<name>.<ext>`. See the [CLI reference](../reference/cli.md).
