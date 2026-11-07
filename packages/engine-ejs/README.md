# @nestvexa/engine-ejs

An isolated [EJS](https://ejs.co) 7.0.2 adapter implementing the `ViewEngineAdapter` contract from `@nestvexa/views`. Use it for Nest MVC views and Live component templates instead of, or next to, the default Handlebars engine. Alpha software; consult the root release blockers before production use.

## Install

The package is not published yet: install the workspace package or the local tarball produced by `pnpm build && pnpm test:pack`. Future registry syntax after owner-authorized publication: `npm install @nestvexa/engine-ejs`, `pnpm add @nestvexa/engine-ejs` or `yarn add @nestvexa/engine-ejs`. Node 22+, ESM (the `default` export condition also lets CommonJS hosts load it through `require(esm)`). Dependencies are `@nestvexa/views` and pinned `ejs` 7.0.2 (Apache-2.0); there are no peer dependencies. The `nestvexa` umbrella does **not** install this package; the default install stays HBS-only, and `nestvexa add engine ejs` adds and wires it.

## Minimal usage

```ts
import { EjsEngine } from '@nestvexa/engine-ejs';
import { SafeHtml } from '@nestvexa/views';

const engine = new EjsEngine({
  root: 'src/views',
  cache: process.env.NODE_ENV === 'production',
  defaultLayout: 'layouts/main',
  partials: { footer: 'partials/footer' },
});
await engine.initialize();
const html = await engine.render(
  'home',
  { title: '<Hello>' },
  { slots: { sidebar: SafeHtml.trusted(renderedSidebar) } },
);
await engine.dispose();
```

`home.ejs`: `<h1><%= title %></h1><%- include('footer') %>`. `layouts/main.ejs`: `<main><%= body %></main><aside><%= slots.sidebar %></aside>`.

### NestJS MVC (Express)

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
await engine.initialize();
app.engine(
  'ejs',
  (
    file: string,
    options: Record<string, unknown>,
    done: (error: Error | null, html?: string) => void,
  ) => engine.renderFile(file, options, done),
);
app.setBaseViewsDir(root); // the same directory as `root`
app.setViewEngine('ejs');
```

Controllers then use Nest's `@Render('home')` normally. `renderFile` maps the absolute filename back to a root-relative view ID, rejects files outside the root and strips Express `settings`, `_locals` and `cache` before rendering. On Fastify, decorate the reply once: `fastify.decorateReply('view', async function (view, model) { return this.type('text/html; charset=utf-8').send(await engine.render(view, model)); })`. In an umbrella app, `NestvexaModule.forRoot({ views })` keeps HBS as the primary engine; render `.ejs` views next to it with `await registerViewEngine(app, 'ejs', engine)` from `nestvexa` before `app.listen()` (Express `app.engine()`, Fastify `reply.view` extension dispatch). Without the umbrella, register the adapter manually as shown.

### Live components

Pass the instance as the Live renderer: `LiveModule.register({ components: [Counter], renderer: engine, origin, resolveIdentity, authorize })`. Component templates use ordinary EJS and client directives need no escaping: `<output><%= count %></output><button type="button" nv:click="increment">+</button>`. `LiveRuntime.mount()` returns `SafeHtml`; print it with `<%= widget %>` in the page view. Initialize and dispose the engine in the host lifecycle (see `examples/live-counter` for the pattern).

## Escaping semantics

| Syntax         | Behavior                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<%= value %>` | HTML-escapes `& < > " '`. Framework `SafeHtml` (Live mounts, slots, layout `body`, helper results) is emitted unescaped. |
| `<%- value %>` | **Raw output, bypasses escaping.** Required for `include(...)`. Never use it for user-controlled strings.                |
| `<% code %>`   | Executes template JavaScript. Templates are trusted application code.                                                    |

`SafeHtml` from the model becomes an engine-private trusted wrapper; browser data and plain objects can never take that path (`{ value: '<x>' }` stays escaped, objects with functions are rejected). Escaping does not validate URL schemes or make values safe inside `<script>`/`<style>`/event-handler contexts; keep untrusted values out of them.

EJS evaluates templates with `with (locals)`: an **undefined top-level name throws** `ReferenceError` (wrapped as `RENDER_FAILED`). Use `locals.optional` for optional values. Top-level model keys `include`, `locals`, `escapeFn`, `rethrow` and keys starting with `__` are rejected because they would shadow EJS internals.

## Includes, layouts, partials and helpers

- `include('/partials/footer')` is root-relative; `include('card')` is relative to the including template; a registered alias (`partials` option or `RenderOptions.partials`) wins. `..`, `.`, absolute OS paths, drive letters, backslashes, control characters, unpaired surrogates and noncharacters are rejected before any filesystem call, and real-path checks reject symlink/junction escapes. Includes must be `.ejs` files. The adapter supplies its own `include` (same arguments and data merging as EJS) because EJS's built-in include probes `fs.existsSync` with the raw reference before any containment hook runs; never pass unvalidated request data to `include()`.
- `defaultLayout` / `RenderOptions.layout` wrap the view; the layout receives the rendered view as trusted `body`. `layout: false` opts out. Layout nesting is composed explicitly (render a layout as a view).
- `helpers` (engine) and `RenderOptions.helpers` (per render) are trusted synchronous functions exposed as locals. A helper name colliding with a model key is rejected. Async helpers are rejected; load data in `ViewEngineRegistry` composers.

## Capabilities

| Capability         | Supported | Notes                                                 |
| ------------------ | --------- | ----------------------------------------------------- |
| `layouts`          | yes       | Adapter composition with trusted `body`.              |
| `partials`         | yes       | `include()` with root containment and aliases.        |
| `slots`            | yes       | `slots.name` from `RenderOptions.slots` (`SafeHtml`). |
| `asyncComposition` | yes       | Through `ViewEngineRegistry` composers before render. |
| `streaming`        | **no**    | Renders complete strings.                             |
| `precompilation`   | **no**    | Templates compile at runtime (cached in production).  |
| `safeHtml`         | yes       | Trusted markup path described above.                  |
| `viewComposers`    | yes       | Request-aware composers via the registry.             |

Check required capabilities at startup with `registry.requireAll('ejs', [...])`; a missing flag fails with a message naming the missing and declared capabilities.

## Options and caching

`root` (required), `cache` (default `false`), `cacheEntries` (256), `maxTemplateBytes` (1 MiB, also enforced for includes), `debug` (defaults to `!cache`), `defaultLayout`, `partials`, `helpers`. Development (`cache: false`) rereads every template per render. Production caches compiled views/layouts and include sources per engine instance (bounded); call `clearCache()` after deploying template changes; `dispose()` releases all caches. EJS 7 has no per-instance compiled-include cache (its cache is process-global and deliberately unused), so included partials are recompiled on each include call even in production. No filesystem watcher is installed.

## Errors

Failures surface as `ViewError`: `INVALID_VIEW` (bad ID, traversal, oversized template), `UNSAFE_MODEL` (model contract) or `RENDER_FAILED` with the original `cause`. With `debug` the message includes the template and line, for example `Unable to render view: home (partials/card.ejs:3)`; production messages contain only the view name. HTTP filters must not expose `cause` to clients.

## Security notes

Templates and helpers are trusted code, never uploads or browser input. Model data never becomes EJS options, so option-injection attacks through `settings['view options']` (for example `outputFunctionName`) do not apply. Models accept finite JSON values, `undefined` and `SafeHtml` only (no class instances, Dates, functions, accessors, symbols, cycles, prototype keys, depth > 32 or > 10,000 values). Keep template directories writable only by deployment tooling.

## Namespaces and themes

`namespaces` (name -> directory) and `themes` (name -> override directory) options resolve `admin::users/index` views and per-render `RenderOptions.theme` overrides for the view, its layout and its includes, with the same containment rules as the root. See the [template engine guide](../../docs/guides/template-engines.md#namespaces-and-themes) for the include rules specific to EJS. Covered by `tests/views-composition.test.ts`.

## Links

See the [template engine guide](../../docs/guides/template-engines.md), the [views API](../views/README.md), [`examples/starter-ejs`](../../examples/starter-ejs/README.md) (MVC pages and Live components rendered by one `EjsEngine`, with `tests/browser/starter-ejs.spec.ts`) and [`examples/cli-generated`](../../examples/cli-generated/README.md).

## Status and limits

Status: **Shipped (alpha)**. The EJS adapter renders MVC views and Live component templates with containment, the model contract and debug line info, and is tested on Express and Fastify.

- No streaming and no precompilation: templates render as complete strings and compile at runtime (cached per instance in production).
- Included partials are recompiled on each include call even in production, because EJS 7 has no per-instance compiled-include cache.
- Layout nesting is composed explicitly (render a layout as a view).
- Template JavaScript runs with `with (locals)`; templates must stay trusted application code.

## Testing

```sh
pnpm --filter @nestvexa/engine-ejs test
```

Runs `tests/engine-ejs.test.ts` (escaping, includes, containment, model contract, caching, errors) and `tests/engine-live.test.ts` (Live components rendered by EJS, Pug and Nunjucks on Express and Fastify); build first with `pnpm --filter @nestvexa/engine-ejs... build` because the tests import `dist`. Namespaces and themes for all adapters are covered by `tests/views-composition.test.ts`, and umbrella registration by `tests/umbrella-view-engines.test.ts`, both in the root suite.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
