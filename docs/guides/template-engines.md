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

## Shared security rules

All first-party adapters, and adapters built with the kit below, enforce the same rules as HBS:

- View IDs are root-relative forward-slash identifiers: no absolute paths, `..`/`.` segments, backslashes, drive letters, `:` streams, empty segments or NUL bytes. Real paths must stay inside the real root (symlink/junction escapes are rejected).
- Template-authored includes follow the same rules: EJS and Pug allow `/x` (root-relative) and descending relative references; Nunjucks names are always root-relative. Raw includes cannot read files outside the root, and template size limits apply to every included file.
- Models accept finite JSON values, `undefined` and `SafeHtml` only. Prototype keys, accessors (never invoked), class instances, functions, symbols, cycles, depth over 32 and more than 10,000 values are rejected.
- Engine features that would widen file access or execution are not used: EJS `renderFile` option merging and global cache, Pug's global cache and `jstransformer-*` auto-loading, Nunjucks `FileSystemLoader`/`watch` and `autoescape: false`.
- Errors are `ViewError` (`INVALID_VIEW`, `UNSAFE_MODEL`, `UNSUPPORTED_CAPABILITY`, `RENDER_FAILED`). With `debug` (default when `cache` is off) messages name the failing template and line; production messages name only the view. Never send `cause` to clients.

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

- `nestvexa add engine <name>` CLI commands (Phase 15) are not implemented; install and wire adapters manually as above.
- Umbrella `NestvexaModule.forRoot({ views: { engine } })` selection of a non-HBS engine is not implemented.
- Streaming, async helpers/filters and precompilation for EJS, Pug and Nunjucks are unsupported.
