# @nestvexa/views

Typed view adapters, per-request composition and explicit trusted HTML for Nestvexa. This package has no browser, template engine or Nest runtime dependency; its adapter kit uses only Node built-ins (`node:fs`, `node:path`), so it is a server-side package. Initial alpha; API may change before 1.0.

Install locally from the workspace or prepared tarball. After authorized publication: `npm install @nestvexa/views`, `pnpm add @nestvexa/views`, or `yarn add @nestvexa/views`. Node 22+; ESM only. No peers required.

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

- `TemplateRoot({ root, extension, maxTemplateBytes? })`: `id(view)`, `assertDirectory()`, real-path `resolve(view, extension?)`/`resolveSync`, size-bounded `read`/`readSync` (BOM stripped), and `viewFromFile(filename)` for Express bridges (undefined outside the root).
- `normalizeViewId(view, extension)`: rejects absolute paths, `..`/`.`/empty segments, backslashes, `:`, NUL and IDs over 240 characters.
- `resolveTemplateReference(parentId, reference)`: include/extends resolution; `/x` is root-relative, other references are relative to the parent, validated like view IDs.
- `copyViewModel(model, trusted, limits?)`: copies finite JSON values into null-prototype objects without invoking accessors and maps only `SafeHtml` through `trusted`; rejects classes, functions, symbols, cycles, prototype keys and oversized structures.
- `assertViewAliases`, `invokeViewHelper` (rejects async results) and `expressViewModel` (strips Express `settings`, `_locals`, `cache`).

See the [template engine guide](../../docs/guides/template-engines.md) for the adapter-author checklist and engine comparison.

`render(engine, view, model, context, composers?, options?)` executes composers sequentially for each request. Later composers override earlier values; explicit model values override composers. Context is passed through without storage. Do not cache private composed props across requests. Root accessors and prototype-pollution keys are rejected before copying; adapters must independently validate their model contract.

`RenderOptions` supports layout ID or false, partial alias -> view ID, synchronous helpers, and named `SafeHtml` slots. Adapter capabilities determine support. No decorators are exported.

`SafeHtml.trusted(markup)` is an explicit escape bypass for application-generated HTML. It does **not** sanitize HTML or make browser text safe. Use ordinary strings for user text. This is a TypeScript application trust boundary, not a sandbox against trusted plugins.

The default distribution includes this package through its HBS integration. See [HBS adapter](../engine-hbs/README.md), [root setup](../../README.md) and [changelog](../../CHANGELOG.md). From the repository root, run `pnpm --filter @nestvexa/views build` and `pnpm exec vitest run tests/views.test.ts` after building both view packages. Compatibility beyond the recorded tested matrix remains unverified; production release gates are tracked at the root.
