# @nestvexa/engine-nunjucks

An isolated [Nunjucks](https://mozilla.github.io/nunjucks/) 3.2.4 adapter implementing the `ViewEngineAdapter` contract from `@nestvexa/views`, for Nest MVC views and Live component templates. Alpha software; consult the root release blockers before production use.

## Install

The package is not published yet: install the workspace package or the local tarball produced by `pnpm build && pnpm test:pack`. Future registry syntax after owner-authorized publication: `npm install @nestvexa/engine-nunjucks`, `pnpm add @nestvexa/engine-nunjucks` or `yarn add @nestvexa/engine-nunjucks`. Node 22+, ESM (the `default` export condition also lets CommonJS hosts load it through `require(esm)`). Dependencies are `@nestvexa/views` and pinned `nunjucks` 3.2.4 (BSD-2-Clause); there are no peer dependencies and the published declarations do not require `@types/nunjucks`. The `nestvexa` umbrella does **not** install this package; the default install stays HBS-only, and `nestvexa add engine nunjucks` adds and wires it.

## Minimal usage

```ts
import { NunjucksEngine } from '@nestvexa/engine-nunjucks';

const engine = new NunjucksEngine({
  root: 'src/views',
  cache: process.env.NODE_ENV === 'production',
  filters: { upper: (value) => String(value).toUpperCase() },
});
await engine.initialize();
const html = await engine.render('home', { title: '<Hello>' });
await engine.dispose();
```

```njk
{# layouts/base.njk #}
<body>{% block content %}{% endblock %}{% include "partials/footer.njk" %}</body>

{# home.njk #}
{% extends "layouts/base.njk" %}
{% block content %}<h1>{{ title }}</h1>{% endblock %}
```

### NestJS MVC (Express)

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
await engine.initialize();
app.engine(
  'njk',
  (
    file: string,
    options: Record<string, unknown>,
    done: (error: Error | null, html?: string) => void,
  ) => engine.renderFile(file, options, done),
);
app.setBaseViewsDir(root);
app.setViewEngine('njk');
```

Use Nest's `@Render('home')` as usual. Do not call `nunjucks.configure(...).express(app)`: that installs Nunjucks' unrestricted `FileSystemLoader`. On Fastify: `fastify.decorateReply('view', async function (view, model) { return this.type('text/html; charset=utf-8').send(await engine.render(view, model)); })`. In an umbrella app, `NestvexaModule.forRoot({ views })` keeps HBS as the primary engine; render `.njk` views next to it with `await registerViewEngine(app, 'njk', engine)` from `nestvexa` before `app.listen()` (Express `app.engine()`, Fastify `reply.view` extension dispatch). Without the umbrella, register the adapter manually as shown.

### Live components

`LiveModule.register({ components: [Counter], renderer: engine, ... })`. Component templates are ordinary HTML: `<output>{{ count }}</output><button type="button" nv:click="increment">+</button>`. Print the `SafeHtml` returned by `LiveRuntime.mount()` with `{{ widget }}`.

## Escaping semantics

| Syntax                   | Behavior                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `{{ value }}`            | Autoescaped. Framework `SafeHtml` (Live mounts, slots, layout `body`, helper results) is emitted unescaped. |
| `{{ value \| safe }}`    | **Bypasses escaping.** Never apply it to user-controlled strings.                                           |
| `{% raw %}…{% endraw %}` | Literal template text, not data.                                                                            |

Autoescaping is always enabled and cannot be disabled through adapter options. `SafeHtml` is converted to Nunjucks' own `SafeString` only by the adapter; data such as `{ val: '<x>' }` stays escaped. Escaping does not validate URLs or make values safe inside `<script>`/`<style>`.

## Includes, layouts, partials, filters and helpers

- Template names in `include`, `extends`, `import` and `from` are **root-relative IDs** (`"partials/footer.njk"`). The loader defines no relative-name resolution, so `./x` and `../x` are rejected, as are absolute paths, drive letters, backslashes and NUL bytes; real-path checks reject symlink/junction escapes. A traversal attempt surfaces as `ViewError('INVALID_VIEW')`.
- Names without the `.njk` extension resolve through partial aliases first (`RenderOptions.partials`, then the `partials` option) and are never cached, so render-local aliases cannot be served stale. Names ending in `.njk` are cached in production.
- Native `extends`/`block` and macros work. `defaultLayout` / `RenderOptions.layout` add an adapter layout that receives trusted `body`.
- `helpers` become environment globals, `filters` become filters, and `RenderOptions.helpers` become per-render context functions (collisions with model keys are rejected). All are trusted and synchronous; async results are rejected. Load data in `ViewEngineRegistry` composers.

## Capabilities

| Capability         | Supported | Notes                                                       |
| ------------------ | --------- | ----------------------------------------------------------- |
| `layouts`          | yes       | Native `extends`/`block`, plus adapter layout.              |
| `partials`         | yes       | `include`/`import` with root containment and aliases.       |
| `slots`            | yes       | `slots.name` from `RenderOptions.slots`.                    |
| `asyncComposition` | yes       | Through `ViewEngineRegistry` composers (no async filters).  |
| `streaming`        | **no**    | Renders complete strings.                                   |
| `precompilation`   | **no**    | Nunjucks precompiled loaders are not wired by this adapter. |
| `safeHtml`         | yes       | Via Nunjucks `SafeString`.                                  |
| `viewComposers`    | yes       | Request-aware composers via the registry.                   |

## Options and caching

`root` (required), `cache` (default `false`), `maxTemplateBytes` (1 MiB, also enforced for includes), `debug` (defaults to `!cache`), `defaultLayout`, `partials`, `helpers`, `filters`, `trimBlocks`, `lstripBlocks`. Development rereads templates per render. Production caches compiled templates by name in the environment's per-loader cache (kept in a null-prototype object); call `clearCache()` after deployments; `dispose()` releases it. Nunjucks' `watch` mode is not used.

## Errors

`ViewError` with `INVALID_VIEW`, `UNSAFE_MODEL` or `RENDER_FAILED` (original cause chain retained). With `debug`, messages name the innermost template and its 1-based line, for example `Unable to render view: home (partials/card.njk:3)`; the adapter corrects Nunjucks' zero-based runtime line numbers. Production messages contain only the view name.

## Security notes

Never render templates from browser input (`renderString` with user text is code execution). Templates, filters and helpers are trusted code. Models accept finite JSON values, `undefined` and `SafeHtml` only; prototype keys, accessors, class instances, functions, symbols, cycles and oversized structures are rejected without invoking getters.

## Namespaces and themes

`namespaces` (name -> directory) and `themes` (name -> override directory) options resolve `admin::users/index` views and per-render `RenderOptions.theme` overrides for the view, its layout and its includes, with the same containment rules as the root. See the [template engine guide](../../docs/guides/template-engines.md#namespaces-and-themes) for the include rules specific to Nunjucks. Covered by `tests/views-composition.test.ts`.

## Links

See the [template engine guide](../../docs/guides/template-engines.md), the [views API](../views/README.md), [`examples/cli-generated`](../../examples/cli-generated/README.md) (a `nestvexa make:page --renderer nunjucks` page).

## Status and limits

Status: **Shipped (alpha)**. The Nunjucks adapter renders MVC views and Live component templates with containment, the model contract and debug line info, and is tested on Express and Fastify.

- No streaming, and Nunjucks precompiled loaders are not wired by this adapter.
- Template names are root-relative IDs only; relative `./x`/`../x` references are rejected.
- Filters and helpers must be synchronous; async filters are rejected.
- Never render templates from browser input (`renderString` with user text is code execution).

## Testing

```sh
pnpm --filter @nestvexa/engine-nunjucks test
```

Runs `tests/engine-nunjucks.test.ts` (escaping, loader containment, aliases, caching, line-corrected errors) and `tests/engine-live.test.ts` (Live components rendered by EJS, Pug and Nunjucks on Express and Fastify); build first with `pnpm --filter @nestvexa/engine-nunjucks... build` because the tests import `dist`. Namespaces and themes for all adapters are covered by `tests/views-composition.test.ts`, and umbrella registration by `tests/umbrella-view-engines.test.ts`, both in the root suite.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
