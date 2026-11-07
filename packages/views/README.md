# @nestvexa/views

Typed view adapters, per-request composition and explicit trusted HTML for Nestvexa. This package has no browser, template engine or Nest runtime dependency; its adapter kit uses only Node built-ins (`node:fs`, `node:path`), so it is a server-side package. Initial alpha; API may change before 1.0.

## Install

Not published yet. Build local tarballs with `pnpm build && pnpm test:pack` (written to `artifacts/packages`) and install the `.tgz` file, or use the workspace package. After owner-authorized publication the registry syntax will be `npm install @nestvexa/views`, `pnpm add @nestvexa/views` or `yarn add @nestvexa/views`. Node 22+; ESM only. No peers and no runtime dependencies.

## Architecture and dependencies

This is the contract layer every server-rendered package builds on: `@nestvexa/engine-hbs`, `@nestvexa/engine-ejs`, `@nestvexa/engine-pug` and `@nestvexa/engine-nunjucks` implement `ViewEngineAdapter`, and `@nestvexa/live`, `@nestvexa/inertia`, `@nestvexa/islands`, `@nestvexa/i18n`, `@nestvexa/ui` and `@nestvexa/vite` use its `SafeHtml` for trusted markup. The `nestvexa` umbrella depends on it and includes it through its HBS integration, so a default install already has it. See [HBS adapter](../engine-hbs/README.md) and [root setup](../../README.md).

## Usage

```ts
import { ViewEngineRegistry } from '@nestvexa/views';
const views = new ViewEngineRegistry();
views.register(engine); // implements ViewEngineAdapter
await views.initialize();
const html = await views.render(
  'hbs',
  'home',
  { title: 'Hello' },
  requestContext,
);
await views.dispose();
```

`ViewEngineAdapter` defines initialize/render/dispose and explicit layout, partial, slot, async composition, streaming, precompilation, trusted HTML and composer capabilities. `ViewEngineRegistry` rejects duplicate/unknown names and malformed adapters (every capability flag must be a boolean, extensions look like `.ejs`, lifecycle methods exist), checks capability requests, rolls back initialized adapters after a startup failure and attempts all shutdowns. Engines are trusted application code.

`require(name, capability)` and `requireAll(name, capabilities)` are startup gates. A missing capability throws `ViewError('UNSUPPORTED_CAPABILITY')` naming every missing flag and the flags the adapter declares, for example `Engine pug does not support precompilation. Declared capabilities: layouts, partials, slots, ...`.

## Adapter kit

The first-party EJS, Pug and Nunjucks adapters and the [custom engine example](../../examples/custom-engine/README.md) share these exports, which implement the same trust boundary as the HBS adapter:

- `TemplateRoot({ root, extension, maxTemplateBytes? })`: `id(view)`, `assertDirectory()`, real-path `resolve(view, extension?)`/`resolveSync`, size-bounded `read`/`readSync` (BOM stripped; `maxTemplateBytes` defaults to 1 MiB), and `viewFromFile(filename)` for Express bridges (undefined outside the root).
- `normalizeViewId(view, extension)`: rejects absolute paths, `..`/`.`/empty segments, backslashes, `:`, NUL and IDs over 240 characters.
- `resolveTemplateReference(parentId, reference)`: include/extends resolution; `/x` is root-relative, other references are relative to the parent, validated like view IDs.
- `copyViewModel(model, trusted, limits?)`: copies finite JSON values into null-prototype objects without invoking accessors and maps only `SafeHtml` through `trusted`; rejects classes, functions, symbols, cycles, prototype keys and oversized structures.
- `assertViewAliases`, `invokeViewHelper` (rejects async results) and `expressViewModel` (strips Express `settings`, `_locals`, `cache`).

See the [template engine guide](../../docs/guides/template-engines.md) for the adapter-author checklist and engine comparison.

## Namespaces, themes, helpers and error pages

- `TemplateRoot({ root, extension, namespaces?, themes? })` resolves `admin::users/index` inside a registered namespace directory, lets the application override namespaced views at `<root>/vendor/<namespace>/...`, and searches a theme override directory first when `resolve(view, extension, theme)` (or `RenderOptions.theme`) names a registered theme. `parseViewName`, `normalizeQualifiedViewId` and the namespace-aware `resolveTemplateReference` are exported for adapters. Unknown namespaces and themes fail with `INVALID_VIEW`.
- `RouteTable` + `routeHelpers` (`route(name, params?)`), `routesFromControllers(controllers, { prefix, name })` (reads Nest `@Controller`/`@Get` path metadata), `pageMetaHelpers` (`pageTitle`, `metaTags`), `permissionHelpers(check)` (`can`/`cannot`, fail-closed), `grantPermissions(check, abilities)` (precomputed view data for `@Render`), `assetHelpers(provider)` (`assetTags(name, nonce?)` over the `ViewAssetProvider` interface that `ViteAssets` matches) and `helperArguments` (Handlebars hash / Nunjucks keywords / plain arguments). All are synchronous; markup they build is escaped.
- `ViewErrorPageFilter` (structural catch-all Nest filter) and `renderErrorPage(error, { render, views, development })`: configurable production 404/5xx views with a fixed `{ status, title, message? }` model, Nest JSON bodies for non-HTML requests, and an escaped development page naming the failing template and line (`templateLocation(error)`).

See the [template engine guide](../../docs/guides/template-engines.md#namespaces-and-themes) for search order, engine differences and examples. Tests: `tests/views-composition.test.ts`, `tests/views-error-pages.test.ts`.

## Composition and trusted HTML

`render(engine, view, model, context, composers?, options?)` executes composers sequentially for each request. Later composers override earlier values; explicit model values override composers. Context is passed through without storage. Do not cache private composed props across requests. Root accessors and prototype-pollution keys are rejected before copying; adapters must independently validate their model contract.

`RenderOptions` supports layout ID or false, partial alias -> view ID, synchronous helpers, named `SafeHtml` slots and a registered `theme`. Adapter capabilities determine support. No decorators are exported. This package still has no Nest dependency: the error filter and controller-route reader are structural.

`SafeHtml.trusted(markup)` is an explicit escape bypass for application-generated HTML. It does **not** sanitize HTML or make browser text safe. Use ordinary strings for user text. This is a TypeScript application trust boundary, not a sandbox against trusted plugins.

## Examples

[starter-hbs](../../examples/starter-hbs/README.md), [starter-ejs](../../examples/starter-ejs/README.md) and the [custom engine example](../../examples/custom-engine/README.md).

## Status and limits

Status: **Shipped (alpha)**. The adapter contract, registry, adapter kit, composers, `SafeHtml`, namespaces, themes, route/meta/permission/asset helpers and error pages work and are tested with all four first-party engines.

- Capabilities differ per engine: streaming, async helpers/filters and precompilation are unsupported in EJS, Pug and Nunjucks (see the [guide](../../docs/guides/template-engines.md#not-yet-available)).
- Themes with precompiled HBS views are not supported.
- `routesFromControllers` encodes neither host nor version constraints and uses only the first path of a multi-path handler.
- `SafeHtml` does not sanitize; sanitizing untrusted HTML is the application's job.
- Compatibility beyond the recorded tested matrix remains unverified; production release gates are tracked at the root.

## Testing

```sh
pnpm --filter @nestvexa/views test
```

Runs `tests/views.test.ts`, `tests/views-*.test.ts` (composition, error pages) and `tests/property-view-paths.test.ts` with the root Vitest config; the tests import `packages/*/dist`, including the four engine adapters and `@nestvexa/vite`, so run `pnpm --filter @nestvexa/views... --filter "@nestvexa/engine-*" --filter @nestvexa/vite build` first.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
