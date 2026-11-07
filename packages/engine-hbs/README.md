# @nestvexa/engine-hbs

An isolated Handlebars 4.7.10 adapter implementing the `ViewEngineAdapter` contract from `@nestvexa/views`. It is the default engine of the `nestvexa` umbrella, which depends on it, configures native Nest `@Render` with it and uses it as the Live renderer. Default HBS rendering requires no React, Vue, Svelte or Vite installation. Alpha software; consult the root release blockers before production use.

## Install

The package is not published yet: use the workspace package or the local tarball produced by `pnpm build && pnpm test:pack`. Future registry syntax after owner-authorized publication: `npm install @nestvexa/engine-hbs`, `pnpm add @nestvexa/engine-hbs`, or `yarn add @nestvexa/engine-hbs`. Applications using `nestvexa` get it automatically. Node 22+, ESM (the `default` export condition lets CommonJS hosts load it through `require(esm)`); dependencies are `@nestvexa/views` and pinned Handlebars 4.7.10, with no peers.

## Usage

```ts
import { HbsEngine } from '@nestvexa/engine-hbs';
const engine = new HbsEngine({
  root: 'src/views',
  defaultLayout: 'layouts/main',
  partials: { footer: 'partials/footer' },
});
await engine.initialize();
const html = await engine.render('home', { title: '<Hello>' });
await engine.dispose();
```

`home.hbs`: `<h1>{{title}}</h1>{{> footer}}`.
`layouts/main.hbs`: `<main>{{body}}</main>`.
Layout body is internally trusted rendered HTML. Named trusted slots use `{{slots.sidebar}}` and `render` options `{ slots: { sidebar: SafeHtml.trusted(renderedFragment) } }`. The explicit trusted API belongs to `@nestvexa/views`; never wrap user input. Normal interpolation escapes HTML. Triple braces intentionally bypass escaping and must only appear in trusted templates. Escaping alone does not validate URL schemes or script/style contexts; avoid placing untrusted values there.

## API, options and security

Public API: `HbsEngine`, `HbsOptions`, `HbsPrecompiledViews`, `render(view, model, options?)` (`layout`, `partials`, `helpers`, `slots`, `theme`), `renderFile(filename, model, callback)` (Express bridge), `registerHelpers(helpers)`, `precompile(views)`, `initialize`, `clearCache`, `dispose`, `name`, `extensions`, `capabilities`. The umbrella configures native Nest `@Render`; the low-level package itself registers no routes or global hooks. No decorators exported.

`registerHelpers(helpers)` adds trusted engine-wide helpers after construction, which is how optional packages such as `@nestvexa/i18n`, `@nestvexa/ui` and `@nestvexa/flags` plug into an engine owned by the umbrella: call `app.get(HbsEngine).registerHelpers(...)` before `configureNestvexa(app)`. Registration is locked once `initialize()` or the first render runs; duplicate names, non-function values, accessors and the reserved `nv` + uppercase prefix are rejected. Helpers receive the Handlebars context as `this`, so trusted block helpers can render their body with `options.fn(this)`.

Each engine has its own Handlebars environment. Options include `helpers`, `partials`, `defaultLayout`, `cache` (false), `cacheEntries` (256), `maxTemplateBytes` (1 MiB), `debug` (default `!cache`), `namespaces` and `themes`. Namespaced views (`admin::users/index`) and per-render themes (`render(view, model, { theme })`) follow the [template engine guide](../../docs/guides/template-engines.md#namespaces-and-themes). With `debug`, failures name the template and line: `Unable to render view: home (partials/row.hbs:2)` for parse errors, helper exceptions, built-in helper misuse, missing helpers and missing partials. Render-local helpers/partials override engine defaults. Helpers are synchronous trusted server code; async data belongs in request-aware `ViewEngineRegistry` composers. Helper exceptions become `ViewError` with their original cause; production HTTP filters must not expose cause stacks. `renderFile` strips Express settings/_locals/cache metadata; pass only public controller data.

Root is an operating-system path, including Windows paths; template IDs use forward slashes, optional `.hbs`, and no absolute paths, `..`, backslashes, streams or null bytes. Real-path checks reject symlinks outside the root. Keep template directories writable only by trusted deployment tooling: these checks are not a defense against concurrent privileged filesystem mutation. Templates and helpers are trusted application code, never browser uploads.

Models allow finite JSON values, undefined and explicit `SafeHtml`; reject class instances, Dates (format first), BigInt, functions, getters/setters, symbols, cycles, dangerous property names, depth over 32 or over 10,000 values. Do not pass ORM entities, Nest request objects, injected services or secrets. Model validation prevents prototype traversal; Handlebars prototype access and missing-helper calls remain disabled.

Capabilities: layouts, partials, slots via trusted composition, async composition and request-aware composers through views registry, safe HTML and precompilation. Streaming is **unsupported**. Layouts nest: a layout whose source starts with `{{!< layouts/base}}` renders inside `layouts/base` (up to 8 levels, cycles rejected, slots and model available at every level). Production caching retains at most the configured entry count; call `clearCache` after deployment changes. Development mode rereads files per render. No filesystem watcher is installed.

## Precompiled production views

Build an explicit allowlist of trusted templates. The generator uses the same canonical-path and template-size checks as rendering and returns deterministic ESM source. Include every referenced partial and layout in the allowlist. It never discovers modules from HTTP input.

```js
// scripts/build-views.mjs
import { writeFile } from 'node:fs/promises';
import { HbsEngine } from '@nestvexa/engine-hbs';
const compiler = new HbsEngine({ root: 'src/views' });
await writeFile(
  'views.precompiled.mjs',
  await compiler.precompile(['home', 'layouts/main', 'partials/footer']),
);
await writeFile(
  'views.precompiled.d.mts',
  `
import type { HbsPrecompiledViews } from '@nestvexa/engine-hbs';
declare const views: HbsPrecompiledViews;
export default views;
`,
);
```

```ts
import templates from './views.precompiled.mjs';
import { HbsEngine } from '@nestvexa/engine-hbs';
const production = new HbsEngine({
  root: 'src/views',
  precompiled: templates,
  defaultLayout: 'layouts/main',
  partials: { footer: 'partials/footer' },
});
await production.initialize();
const html = await production.render('home', { title: 'Precompiled' });
```

The precompiled map contains executable application code, not JSON. Load only your trusted build artifact, using a static import. In this mode the original `.hbs` files/root need not exist, missing registered views fail closed, layout parents recorded by `{{!< parent}}` are kept, themes are refused with `UNSUPPORTED_CAPABILITY`, and there is no source compilation fallback or module loading by view ID. The root remains necessary for the Express filename bridge. Rebuild modules and restart after template changes; `clearCache` affects source-mode caching only. Match compiler/runtime Handlebars versions through the lockfile. This API avoids compilation during rendering; it does not currently strip the compiler dependency from the server bundle. Upstream contracts: [precompile/template](https://handlebarsjs.com/api-reference/compilation.html), [runtime security options](https://handlebarsjs.com/api-reference/runtime-options.html).

## Links

See the [template engine guide](../../docs/guides/template-engines.md), the [views API](../views/README.md), the [root setup](../../README.md) and [`examples/starter-hbs`](../../examples/starter-hbs/README.md). The framework compatibility matrix and pack-consumer checks are root release gates.

## Status and limits

Status: **Shipped (alpha)**. Rendering, nested layouts, namespaces, themes, debug line info, helper registration and precompiled views are implemented and tested.

- Streaming is unsupported; views render as complete strings.
- Precompiled mode refuses themes and does not strip the Handlebars compiler from the server bundle.
- Helpers must be synchronous; async data belongs in `ViewEngineRegistry` composers.
- Layout nesting stops at 8 levels; template directories must be writable only by trusted deployment tooling.

## Testing

```sh
pnpm --filter @nestvexa/engine-hbs test
```

Runs `tests/views.test.ts` (trust boundaries, containment, model contract, caching, precompilation) and `tests/views-composition.test.ts` (namespaces, themes, nested layouts, development line info, link/metadata helpers); build first with `pnpm --filter @nestvexa/engine-hbs... build` because the tests import `dist`. View-rendered error pages (`tests/views-error-pages.test.ts`) and helper registration by `@nestvexa/i18n` (`tests/i18n-hbs.test.ts`) run in the root suite, and `tests/browser/mvc.spec.ts` covers HBS pages through the root Playwright config.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
