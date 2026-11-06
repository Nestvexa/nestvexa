---
'@nestvexa/core': minor
'@nestvexa/live': minor
'nestvexa': patch
---

Core: `normalizeOptions` reports every invalid path in a `NestvexaConfigError`
(`issues: { path, expected }[]`, never values) and accepts the canonical
`live.client`; `mergeNestvexaOptions` and `nestvexaOptionsFromEnvironment`
give explicit file < environment < override layering; `CoreModule.forRootAsync`
supports `useClass`/`useExisting` and opt-in `global` registration;
`FeatureCapabilityRegistry` declares degraded support and `report()`s a frozen
snapshot; `NESTVEXA_ERROR_CODES` documents each code.

Live: capability negotiation over a bounded `x-nestvexa-capabilities` token
list (malformed headers are rejected with 400 `INVALID_CAPABILITIES`;
`renderless-v1, other-v1` now negotiates renderless), published request/response/
error JSON Schemas, `LIVE_ERROR_CODES`, `@Action({ idempotent, concurrency })`,
`@LiveComponent({ timeoutMs })` with `liveAbortSignal`, graceful shutdown drain,
`@State({ default, serializer })`, typed synthesizers (`defineSynthesizer`,
enum, nullable, Set, Map) and a startup check rejecting host routes that
collide with generated Live routes.

Umbrella: `live.client`, when configured, must match the Live browser mode.
