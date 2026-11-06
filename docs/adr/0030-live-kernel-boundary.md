# 0030 — Live depends on the view contracts, not on the core kernel

Status: accepted, 2026-11-06. Resolves ARCH-010.

## Context

The master specification (section 3.1, ledger row ARCH-010) describes `@nestvexa/live`
as "server runtime … depends on core/views". The implementation has always declared
`@nestvexa/live → @nestvexa/views` only, and the
[dependency graph](../architecture/package-dependency-graph.md) noted the deviation
without a dedicated decision. This ADR evaluates aligning the code with the wording.

What Live would gain from a `core` dependency today:

- `NestvexaConfigService`: Live already receives its configuration through
  `LiveModule.register()` / `registerAsync()`; the normalized core options carry no Live
  policy (origin, identity, authorization, store) and could not without making core
  aware of Live.
- `NestvexaError` / `FeatureCapabilityRegistry`: Live reports protocol failures as HTTP
  envelopes (`LIVE_ERROR_CODES`) and negotiates per-request client capabilities
  (`LIVE_CAPABILITIES`), which are different concerns from start-up configuration errors
  and adapter capability declarations.

## Decision

Keep `@nestvexa/live` independent of `@nestvexa/core`. Live depends on
`@nestvexa/views` (the renderer adapter and `SafeHtml` contracts) plus the NestJS peers.
The integration between the kernel configuration and Live lives in the `nestvexa`
umbrella, which:

- requires `live.enabled: true` for an explicit Live registration and rejects
  `security.csrf` / `security.requireAuthorizedActions` set to `false`;
- verifies `live.client` (when configured) equals the Live browser mode;
- shares one HBS renderer between MVC and Live.

## Rejected alternatives

- **Add `live → core` now.** It would add an edge that no Live code uses, force every
  standalone Live user to install and register the kernel, and invite core to grow Live
  policy fields, coupling two packages that release independently.
- **Move Live policy into core options.** Identity resolvers, authorization callbacks and
  stores are functions/objects resolved through Nest DI, not serializable configuration;
  putting them in `NestvexaOptions` would break its plain-data validation contract.

## Consequences

- Live keeps working without the kernel (`LiveModule.register` with any views adapter),
  as the `live-counter` example and the Live test suites show.
- The specification wording remains "core/views"; this ADR is the recorded deviation.
  If Live later needs a kernel service (for example a shared diagnostics registry), add
  the edge then, together with the code that uses it, and amend this ADR.
- `scripts/boundaries.mjs` and the docs graph check keep the declared graph honest.

## Evidence

- [Package dependency graph](../architecture/package-dependency-graph.md) (checked by
  `pnpm docs:build`).
- [Architecture runtime test](../../tests/architecture-runtime.test.ts): core loads only
  core modules in a plain Node process; Live loads no DOM or frontend modules.
- [Umbrella tests](../../tests/umbrella-live.test.ts): kernel/Live consistency checks.
