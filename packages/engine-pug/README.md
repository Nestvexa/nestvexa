# @nestvexa/engine-pug

An isolated [Pug](https://pugjs.org) 3.0.4 adapter implementing the `ViewEngineAdapter` contract from `@nestvexa/views`, for Nest MVC views and Live component templates. Alpha software; consult the root release blockers before production use.

## Install

After owner-authorized publication: `npm install @nestvexa/engine-pug`, `pnpm add @nestvexa/engine-pug` or `yarn add @nestvexa/engine-pug`. Before publication, use the workspace or a packed tarball. Node 22+, ESM only. Dependencies are `@nestvexa/views` and pinned `pug` 3.0.4 (MIT); there are no peer dependencies. The `nestvexa` umbrella does **not** install this package; the default install stays HBS-only.

## Minimal usage

```ts
import { PugEngine } from '@nestvexa/engine-pug';

const engine = new PugEngine({
  root: 'src/views',
  cache: process.env.NODE_ENV === 'production',
  doctype: 'html',
});
await engine.initialize();
const html = await engine.render('home', { title: '<Hello>' });
await engine.dispose();
```

```pug
//- layouts/base.pug
doctype html
html
  body
    block content
    include /partials/footer

//- home.pug
extends /layouts/base
block content
  h1= title
```

### NestJS MVC (Express)

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
await engine.initialize();
app.engine(
  'pug',
  (
    file: string,
    options: Record<string, unknown>,
    done: (error: Error | null, html?: string) => void,
  ) => engine.renderFile(file, options, done),
);
app.setBaseViewsDir(root);
app.setViewEngine('pug');
```

Use Nest's `@Render('home')` as usual. `renderFile` rejects files outside the root and strips Express `settings`, `_locals` and `cache`. On Fastify: `fastify.decorateReply('view', async function (view, model) { return this.type('text/html; charset=utf-8').send(await engine.render(view, model)); })`. The umbrella's `NestvexaModule.forRoot({ views })` currently configures only HBS; register this adapter manually.

### Live components

`LiveModule.register({ components: [Counter], renderer: engine, ... })`. Pug attribute syntax accepts Nestvexa and Alpine directives without escaping:

```pug
output= count
button(type="button" nv:click="increment" @click="open = !open") +
```

In the page, print the `SafeHtml` returned by `LiveRuntime.mount()` with `= widget`.

## Escaping semantics

| Syntax                                | Behavior                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `= value`, `#{value}`                 | HTML-escaped. Framework `SafeHtml` (Live mounts, slots, layout `body`, helper results) is emitted unescaped. |
| `attr=value`                          | Attribute values are always escaped; `SafeHtml` is **never** emitted as raw attribute markup.                |
| `!= value`, `!{value}`, `attr!=value` | **Raw output, bypasses escaping.** Never use it for user-controlled strings.                                 |
| `- code`                              | Executes template JavaScript. Templates are trusted application code.                                        |

The adapter compiles with Pug's documented `compileClient` and binds the result to Pug's own runtime whose `escape` additionally recognizes an engine-private trusted wrapper created only from server `SafeHtml`. Plain objects such as `{ value: '<x>' }` stay escaped. Escaping does not validate URLs or make values safe inside `script`/`style` blocks. Top-level model keys `pug`, `pug_*`, `self` and `locals` are rejected because they collide with compiled-template internals.

## Includes, layouts, mixins, filters and helpers

- `include`/`extends`: `/x` is root-relative; other references are relative to the including file. Pug appends `.pug` to extensionless references; raw includes (for example `include /assets/site.css`) keep their extension and must also live inside the root. `..`, `.`, absolute OS paths, drive letters, backslashes and NUL bytes are rejected before reading, and real-path checks reject symlink/junction escapes. Pug's `basedir` is fixed to the root.
- Native `extends`/`block` layouts and mixins work. `defaultLayout` / `RenderOptions.layout` add an adapter layout that receives trusted `body` (`main= body`).
- **`RenderOptions.partials` is unsupported**: Pug resolves includes at compile time, so a render-time alias map is rejected with `UNSUPPORTED_CAPABILITY`. Use `include` or mixins.
- `filters` registers trusted compile-time text filters (`:name`). Any unregistered filter is rejected with `INVALID_VIEW` before Pug could try to load a `jstransformer-*` module.
- `helpers` (engine) and `RenderOptions.helpers` are trusted synchronous functions exposed as locals; collisions with model keys and async helpers are rejected.

## Capabilities

| Capability         | Supported | Notes                                                                   |
| ------------------ | --------- | ----------------------------------------------------------------------- |
| `layouts`          | yes       | Native `extends`/`block`, plus adapter layout with trusted `body`.      |
| `partials`         | yes       | Compile-time `include` and mixins; render-time alias maps are rejected. |
| `slots`            | yes       | `slots.name` from `RenderOptions.slots`.                                |
| `asyncComposition` | yes       | Through `ViewEngineRegistry` composers before render.                   |
| `streaming`        | **no**    | Renders complete strings.                                               |
| `precompilation`   | **no**    | Runtime compilation, cached in production.                              |
| `safeHtml`         | yes       | Text output only, as described above.                                   |
| `viewComposers`    | yes       | Request-aware composers via the registry.                               |

## Options and caching

`root` (required), `cache` (default `false`), `cacheEntries` (256), `maxTemplateBytes` (1 MiB, also enforced for included files), `debug` (defaults to `!cache`), `defaultLayout`, `helpers`, `filters`, `doctype`. Development rereads and recompiles each view (including its includes) per render. Production caches compiled templates per instance (bounded; includes are baked in); call `clearCache()` after deployments; `dispose()` releases the cache. Pug's process-global `pug.cache` is never used. No watcher is installed.

## Errors

`ViewError` with `INVALID_VIEW`, `UNSAFE_MODEL`, `UNSUPPORTED_CAPABILITY` or `RENDER_FAILED` (original `cause` retained). With `debug`, compile and runtime errors name the template and line, for example `Unable to render view: home (partials/card.pug:2)`; template sources are embedded for diagnostics so Pug never reads files while rethrowing. Production messages contain only the view name.

## Security notes

Templates, filters and helpers are trusted code. Models accept finite JSON values, `undefined` and `SafeHtml` only; prototype keys, accessors, class instances, functions, symbols, cycles and oversized structures are rejected without invoking getters. Pug templates can reference globals; never compile templates from browser input.

## Testing

From the repository root: `pnpm --filter @nestvexa/views --filter @nestvexa/engine-pug build`, then `pnpm exec vitest run tests/engine-pug.test.ts tests/engine-live.test.ts`. See the [template engine guide](../../docs/guides/template-engines.md), [views API](../views/README.md) and [changelog](../../CHANGELOG.md).

## Namespaces and themes

`namespaces` (name -> directory) and `themes` (name -> override directory) options resolve `admin::users/index` views and per-render `RenderOptions.theme` overrides for the view, its layout and its includes, with the same containment rules as the root. See the [template engine guide](../../docs/guides/template-engines.md#namespaces-and-themes) for the include rules specific to Pug. Covered by `tests/views-composition.test.ts`.
