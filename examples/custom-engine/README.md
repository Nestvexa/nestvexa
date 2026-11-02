# Custom template engine example

A complete third-party `ViewEngineAdapter` (`src/engine.ts`) for a deliberately tiny template language, plus a real Nest/Express server (`src/main.ts`) that renders an MVC page and a Live counter with it.

From the repository root: `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm --filter @nestvexa/example-custom-engine start`. Visit `http://127.0.0.1:3103` (`PORT` overrides the port). Set `NODE_ENV=production` to enable template caching.

## The language

- `{{ path.to.value }}` prints an HTML-escaped scalar; missing values print nothing; objects and arrays are rejected with the template line.
- There is **no raw-output syntax**. Only server `SafeHtml` (the Live mount, `RenderOptions.slots`, the layout `body`) is emitted unescaped.
- `defaultLayout` / `RenderOptions.layout` wrap a view; the layout prints `{{ body }}`.

## What the adapter demonstrates

- Honest capabilities: `layouts`, `slots`, `safeHtml`, `asyncComposition` and `viewComposers` (via the registry) are declared; `partials`, `streaming` and `precompilation` are not. `RenderOptions.partials` and `RenderOptions.helpers` are rejected with `UNSUPPORTED_CAPABILITY` instead of being ignored.
- Reuse of the `@nestvexa/views` adapter kit: `TemplateRoot` (root containment, real-path checks, size limits, Express filename mapping), `copyViewModel` (public data only, `SafeHtml` mapping) and `expressViewModel`.
- Per-instance caching enabled by `cache`, released by `dispose()`.
- Development errors name the template and line (`Unable to render view: home (home.tok:3)`); production errors name only the view.
- A startup capability gate in `main.ts`: `views.requireAll('tokens', ['layouts', 'slots', 'safeHtml'])` fails before the server listens if the adapter stops declaring a capability the app needs.
- MVC wiring without the umbrella's HBS module: `app.engine('tok', ...)`, `setBaseViewsDir`, `setViewEngine`, and `@Render('home')`.

The page loads the Nestvexa Live client through `nestvexa/assets` and a CSP-compatible boot module, so the counter button and the live-synchronized note input work in a browser. The session is an anonymous demonstration identity (in-memory `express-session`, random per-process secret), not an authentication system.

## Tests

[`tests/custom-engine.test.ts`](../../tests/custom-engine.test.ts) covers escaping, layouts/slots, unsupported capabilities, traversal, prototype-pollution and error lines, plus registry startup validation and the adapter kit. [`tests/engine-live.test.ts`](../../tests/engine-live.test.ts) mounts and drives a Live counter through this adapter on Express and Fastify, alongside EJS, Pug and Nunjucks. See the [template engine guide](../../docs/guides/template-engines.md) for the full adapter-author checklist.
