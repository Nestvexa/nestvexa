# nestvexa

Default Nestvexa distribution. This alpha integrates Handlebars with normal Nest `@Render` controllers on Express and Fastify. Live and frontend adapters are not yet part of the implemented runtime.

## Installation

Not published. Build and pack locally with `pnpm build && pnpm test:pack`; install all generated tarballs together in a consumer. Future registry commands are `npm install nestvexa`, `pnpm add nestvexa`, or `yarn add nestvexa`, after owner-authorized publication. Peers: Nest common/core 12, reflect-metadata 0.2, RxJS 7; an HTTP platform adapter is host-owned. Tested environment evidence is in [compatibility](../../docs/architecture/upstream-compatibility.md).

## Usage

```ts
import { NestvexaModule, configureNestvexa } from 'nestvexa';
// In @Module imports:
NestvexaModule.forRoot({
  views: { root: 'src/views', layout: 'layouts/main' },
});
// After NestFactory.create, before listen:
await configureNestvexa(app);
```

`forRootAsync({ imports, inject, useFactory })` supports Nest provider injection. Defaults are HBS, `src/views`, no layout, no production template cache, and Live disabled. Use `views.cache: true` for immutable deployed templates. Public exports include `NestvexaModule`, `configureNestvexa`, `HbsEngine` and core/view contracts. It depends on core, views, and engine-hbs; no React/Vue/Svelte or Redis is required.

Fastify integration uses a public reply decorator; it rejects an existing `reply.view` owner. Express integration registers the HBS engine and view root. Configure once before starting the server. App-owned normal Nest guard/pipe/interceptor behavior remains intact because no controller invocation is replaced.

Templates are trusted code; interpolation escapes, triple braces do not. No action endpoint or automatic CSRF middleware is installed in this alpha. See [security hardening](../../docs/security/hardening.md), [starter](../../examples/starter-hbs/README.md), and [changelog](../../CHANGELOG.md). Run `pnpm test:integration` at repository root. ESM-only; Node 22.13+/24 targeted, exact observed coverage recorded separately. Maintainer name, repository and bugs URLs are deliberately absent until supplied by the owner.
