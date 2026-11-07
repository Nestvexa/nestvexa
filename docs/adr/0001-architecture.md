# ADR 0001: Small kernel and default distribution

Status: accepted for the initial MVC implementation; amended 2026-11-07 (current shape, below).

Keep configuration/registries in core, view contracts in views, Handlebars in its adapter, and convenience setup in `nestvexa`. Reject a kernel that imports every renderer: it would increase default installs and create cross-runtime coupling. The cost is more manifests and packed-consumer tests. Views does not import core until a real shared contract requires it.

Use MIT for original implementation; preserve third-party licenses. Owner review of project identity and licensing remains a release step. ESM-only output avoids duplicated module identities; CommonJS consumers need native dynamic import or a future separately verified output policy.

Failure modes: missing tarball assets, workspace-only links and peer duplication. [Pack tests](../../scripts/pack.mjs) and [boundary checks](../../scripts/boundaries.mjs) detect these for the implemented slice. Naming and registry ownership are not inferred from an E404.

2026-10-28 composition decision: the umbrella now depends on Live and re-exports its server API. `forRoot(coreOptions, liveRegistration)` keeps controller structure synchronous while a DI policy factory resolves security dependencies. MVC and Live import the same exported renderer module rather than constructing a second engine or escaping module visibility. Rejected: an async factory deciding component types/routes after Nest discovery; an implicit guest identity; global renderer state. Cost: a second explicit registration argument and independent browser prefix for URI versioning. See [setup boundaries](../guides/default-live-setup.md), [integration tests](../../tests/umbrella-live.test.ts), [async registration tests](../../tests/live-async.test.ts) and [packed consumers](../../tests/pack-consumers/assets.ts).

## Trade-offs and cost

- Thirty small packages instead of one framework package. Each needs its own
  manifest, README, `exports` map, build and test script, and the pack step
  checks every tarball. In return, an app installs only the renderers and
  extensions it uses, and the default `nestvexa` install stays MVC, HBS and
  Live.
- The umbrella is a convenience, not the kernel. Hosts that want a different
  engine or no Live install `@nestvexa/core` and `@nestvexa/views` directly and
  give up the one-call `forRoot` setup.
- ESM-only output means one module identity per package and no dual-package
  hazard. The cost is Node 22.12+ for CommonJS hosts (`require(esm)`, see the
  [ADR 0007 amendment](0007-packaging-and-release.md)) and no top-level `await`
  in any package.
- Keeping core free of renderers needs a boundary script and a contract test,
  and they run on every check.

## Failure modes

- A package imports a sibling it must not use, for example core or views
  importing a renderer, or a framework package importing an optional
  extension. [`scripts/boundaries.mjs`](../../scripts/boundaries.mjs) fails the
  build, and `tests/contracts.test.ts` fails when core gains a renderer
  dependency.
- An `exports` entry loses its `types` or `default` condition, so CommonJS or
  TypeScript consumers break. `tests/contracts.test.ts` checks every entry of
  every package.
- A tarball is missing `dist` files or still has `workspace:*` edges.
  [`scripts/pack.mjs`](../../scripts/pack.mjs) inspects the archives and boots
  packed consumers.
- Two copies of a peer, such as `@nestjs/core`, end up in one app. Peers are
  declared, never bundled ([ADR 0029](0029-peer-dependencies-and-singletons.md)).

## Amendment (2026-11-07): current shape

The decision stands, and the kernel is still small. Since this record was
written:

- The workspace has 30 packages. Each has a `test` script that runs its own
  suites from the root Vitest config. Every `exports` entry has `types`,
  `import` and a matching `default` condition, which `tests/contracts.test.ts`
  enforces for all 30 ([package graph](../architecture/package-dependency-graph.md)).
- `@nestvexa/views` still has no runtime or peer dependencies. Live depends on
  views and not on core ([ADR 0030](0030-live-kernel-boundary.md)).
- The `nestvexa` umbrella depends on core, views, the HBS engine, Live, the
  client, the Alpine adapter and the CLI. Every other package is optional.
- Project identity, licensing and npm scope ownership still need owner review
  before publication. Until then, packages ship only as local tarballs
  ([ADR 0007](0007-packaging-and-release.md)).
