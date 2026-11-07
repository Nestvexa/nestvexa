# @nestvexa/engine-pug

An isolated [Pug](https://pugjs.org) 3.0.4 adapter implementing the `ViewEngineAdapter` contract from `@nestvexa/views`, for Nest MVC views and Live component templates. Alpha software; consult the root release blockers before production use.

## Install

The package is not published yet: install the workspace package or the local tarball produced by `pnpm build && pnpm test:pack`. Future registry syntax after owner-authorized publication: `npm install @nestvexa/engine-pug`, `pnpm add @nestvexa/engine-pug` or `yarn add @nestvexa/engine-pug`. Node 22+, ESM (the `default` export condition also lets CommonJS hosts load it through `require(esm)`). Dependencies are `@nestvexa/views` and pinned `pug` 3.0.4 (MIT); there are no peer dependencies. The `nestvexa` umbrella does **not** install this package; the default install stays HBS-only, and `nestvexa add engine pug` adds and wires it.

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

Use Nest's `@Render('home')` as usual. `renderFile` rejects files outside the root and strips Express `settings`, `_locals` and `cache`. On Fastify: `fastify.decorateReply('view', async function (view, model) { return this.type('text/html; charset=utf-8').send(await engine.render(view, model)); })`. In an umbrella app, `NestvexaModule.forRoot({ views })` keeps HBS as the primary engine; render `.pug` views next to it with `await registerViewEngine(app, 'pug', engine)` from `nestvexa` before `app.listen()` (Express `app.engine()`, Fastify `reply.view` extension dispatch). Without the umbrella, register the adapter manually as shown.

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

## Namespaces and themes

`namespaces` (name -> directory) and `themes` (name -> override directory) options resolve `admin::users/index` views and per-render `RenderOptions.theme` overrides for the view, its layout and its includes, with the same containment rules as the root. See the [template engine guide](../../docs/guides/template-engines.md#namespaces-and-themes) for the include rules specific to Pug. Covered by `tests/views-composition.test.ts`.

## Links

See the [template engine guide](../../docs/guides/template-engines.md), the [views API](../views/README.md), [`examples/cli-generated`](../../examples/cli-generated/README.md) (a `nestvexa make:page --renderer pug` page).

## Status and limits

Status: **Shipped (alpha)**. The Pug adapter renders MVC views and Live component templates with containment, the model contract and debug line info, and is tested on Express and Fastify.

- No streaming and no precompilation: runtime compilation, cached per instance in production.
- `RenderOptions.partials` is unsupported (includes resolve at compile time) and fails with `UNSUPPORTED_CAPABILITY`.
- `SafeHtml` is never emitted as raw attribute markup.
- Pug templates can reference globals; never compile templates from browser input.

## Testing

```sh
pnpm --filter @nestvexa/engine-pug test
```

Runs `tests/engine-pug.test.ts` (escaping, includes, filters, containment, caching, errors) and `tests/engine-live.test.ts` (Live components rendered by EJS, Pug and Nunjucks on Express and Fastify); build first with `pnpm --filter @nestvexa/engine-pug... build` because the tests import `dist`. Namespaces and themes for all adapters are covered by `tests/views-composition.test.ts`, and umbrella registration by `tests/umbrella-view-engines.test.ts`, both in the root suite.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
