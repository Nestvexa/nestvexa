# 0021 — Server-mounted nested components and browser-routed events

Status: accepted for the current experimental implementation.

## Context

Phase 4 requires nested components with mount keys, `@Reactive`/`@Modelable`
props, cross-component events, lazy rendering and redirects. The existing client
already treats every `data-nv-component` root as an ownership boundary that a
parent morph retains, and the server renders through the engine-neutral
`ViewEngineAdapter` contract.

## Decision

1. **Explicit child allowlist** (`children: { alias: Class }`) validated against
   the same registration at startup. Templates use a runtime-supplied `nvChild`
   helper; aliases never resolve classes or paths from client data.
2. **Placeholder substitution**: the helper returns an HTML comment containing a
   per-render 96-bit random nonce. After the engine renders, the runtime mounts or
   retains children and replaces each placeholder exactly once. Escaped model data
   cannot forge a placeholder because `<` is escaped and the nonce is unknown.
3. **Server-side child bookkeeping**: each snapshot entry may hold
   `{ alias, name, id, token }` per child key. This is never sent to the browser.
4. **Stub/refresh protocol**: unchanged children are emitted as empty stubs that
   the browser must match by identity; changed reactive/modelable values re-render
   the child in its own store transaction and mark it `data-nv-refresh`. Only
   marked roots replace existing roots, so earlier host-composition behaviour
   (identical nested markers are retained) is unchanged.
5. **Events travel through the browser** and are delivered as ordinary actions to
   `@OnEvent` listeners. This keeps every listener behind the same generated Nest
   route, guards, pipes and host authorization, at the cost of one request per
   listener and untrusted payloads.

## Rejected alternatives

- **Server-side event fan-out within one request**: would execute other
  components' methods without their own Nest route pipeline and identity checks.
- **Rendering every child on every parent render** (no stubs): loses browser-owned
  child state and multiplies work.
- **Class names or view paths in templates**: violates the no-arbitrary-class rule.
- **Cross-component request batching**: every action must pass through its own
  generated Nest route; a batch endpoint would bypass per-route guards. Requests
  stay per component (isolated by default); fields and the action of one component
  are already sent together in one request.

## Consequences and limits

Depth 8, 200 children per tree, 16 events per action, 16 KiB per payload, 64
listener deliveries per event. A busy child is not refreshed by a parent render.
Events are best effort within the current page and are not persisted or replayed.
Tests: `tests/live-nesting.test.ts`, `tests/client-events-protocol.test.ts`,
`tests/browser/nesting.spec.ts`.
