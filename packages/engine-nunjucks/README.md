# @nestvexa/engine-nunjucks

An isolated [Nunjucks](https://mozilla.github.io/nunjucks/) 3.2.4 adapter implementing the `ViewEngineAdapter` contract from `@nestvexa/views`, for Nest MVC views and Live component templates. Alpha software; consult the root release blockers before production use.

## Install

After owner-authorized publication: `npm install @nestvexa/engine-nunjucks`, `pnpm add @nestvexa/engine-nunjucks` or `yarn add @nestvexa/engine-nunjucks`. Before publication, use the workspace or a packed tarball. Node 22+, ESM only. Dependencies are `@nestvexa/views` and pinned `nunjucks` 3.2.4 (BSD-2-Clause); there are no peer dependencies and the published declarations do not require `@types/nunjucks`. The `nestvexa` umbrella does **not** install this package; the default install stays HBS-only.

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

Use Nest's `@Render('home')` as usual. Do not call `nunjucks.configure(...).express(app)`: that installs Nunjucks' unrestricted `FileSystemLoader`. On Fastify: `fastify.decorateReply('view', async function (view, model) { return this.type('text/html; charset=utf-8').send(await engine.render(view, model)); })`. The umbrella's `NestvexaModule.forRoot({ views })` currently configures only HBS; register this adapter manually.

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

## Testing

From the repository root: `pnpm --filter @nestvexa/views --filter @nestvexa/engine-nunjucks build`, then `pnpm exec vitest run tests/engine-nunjucks.test.ts tests/engine-live.test.ts`. See the [template engine guide](../../docs/guides/template-engines.md), [views API](../views/README.md) and [changelog](../../CHANGELOG.md).
