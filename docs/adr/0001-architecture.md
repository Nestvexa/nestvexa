# ADR 0001: Small kernel and default distribution

Status: accepted for the initial MVC implementation.

Keep configuration/registries in core, view contracts in views, Handlebars in its adapter, and convenience setup in `nestvexa`. Reject a kernel that imports every renderer: it would increase default installs and create cross-runtime coupling. The cost is more manifests and packed-consumer tests. Views does not import core until a real shared contract requires it.

Use MIT for original implementation; preserve third-party licenses. Owner review of project identity and licensing remains a release step. ESM-only output avoids duplicated module identities; CommonJS consumers need native dynamic import or a future separately verified output policy.

Failure modes: missing tarball assets, workspace-only links and peer duplication. [Pack tests](../../scripts/pack.mjs) and [boundary checks](../../scripts/boundaries.mjs) detect these for the implemented slice. Naming and registry ownership are not inferred from an E404.

2026-10-28 composition decision: the umbrella now depends on Live and re-exports its server API. `forRoot(coreOptions, liveRegistration)` keeps controller structure synchronous while a DI policy factory resolves security dependencies. MVC and Live import the same exported renderer module rather than constructing a second engine or escaping module visibility. Rejected: an async factory deciding component types/routes after Nest discovery; an implicit guest identity; global renderer state. Cost: a second explicit registration argument and independent browser prefix for URI versioning. See [setup boundaries](../guides/default-live-setup.md), [integration tests](../../tests/umbrella-live.test.ts), [async registration tests](../../tests/live-async.test.ts) and [packed consumers](../../tests/pack-consumers/assets.ts).
