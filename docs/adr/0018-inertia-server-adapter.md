# 0018 — Inertia v3 server adapter

Status: accepted for the experimental alpha implementation (Phase 8). Framework
packages, Vite integration and a running SSR process remain Phase 9–11 work.

## Context and decision

React/Vue/Svelte pages must use the official Inertia clients, so Nestvexa needs
a server adapter that speaks the published v3 protocol rather than a parallel
JSON API. Implement `@nestvexa/inertia` as a Nest module with:

- a route interceptor (global by default, or per route through
  `@InertiaPage`/`@UseInertia`) that validates `X-Inertia-*` headers, answers
  asset-version mismatches with `409` before the handler, and turns handler
  results into protocol replies through Nest's `HttpAdapterHost`, so the same
  code serves Express and Fastify and keeps guards, pipes and filters intact;
- a per-request props resolver ported from the protocol's evaluation model and
  the reference `inertia-laravel` v3.6.0 `PropsResolver`, including dot-path
  partial filtering and metadata order, verified against golden vectors taken
  from the official documentation and upstream tests;
- immutable prop helpers (`always`, `optional`, `defer`, `merge`, `deepMerge`,
  `once`, `scroll`) whose per-request state (resolved values, merge intent,
  reset) lives only in the resolver;
- host-owned sessions through a small `InertiaSessionAdapter` contract for
  errors, flash data, `clearHistory` and `preserveFragment`;
- a strict JSON normalizer and a script-context escaper, and a redirect policy
  (relative paths or allowlisted origins);
- pluggable root views (default document or any `ViewEngineAdapter`) and an SSR
  renderer contract with an HTTP gateway for the official SSR server.

Correctness is proven with real HTTP requests on both platforms, a security
corpus, and Playwright runs of the official `@inertiajs/react` 3.10.0 client in
Chromium, Firefox and WebKit.

## Alternatives and tradeoffs

- Reject a custom client or "Inertia-like" JSON: it would not work with the
  official adapters and would fork the ecosystem.
- Reject Nest middleware for version checks and redirect conversion: Nest
  middleware sees raw responses differently on Express and Fastify, cannot read
  handler results, and would require patching `writeHead`. The interceptor sees
  results and uses public adapter APIs; the cost is that redirects issued with
  `res.redirect()` bypass 303 conversion, so the adapter offers `redirect()`.
- Reject evaluating lazy values while unpacking dotted shared keys (upstream
  does): it breaks the laziness guarantee. A conflicting dotted key is a
  configuration error instead.
- Reject absolute URLs derived from `Host` in `X-Inertia-Location`: the header
  is client-controlled and could poison shared caches. Relative paths are
  resolved by the official client.
- Reject allowing `errors` to be overridden by shared or page props: it would
  let unrelated code forge validation state; `errors` render option covers the
  legitimate direct-render case.
- Reject silently converting unsupported values (functions, `bigint`, `NaN`,
  Maps, cycles) as `JSON.stringify` does: silent data loss and accidental
  exposure are worse than a loud 500. `bigint` follows the upstream `$bigint`
  marker protocol when explicitly enabled.
- Version strings are namespaced per root when several roots exist, trading an
  opaque version format for a guaranteed full reload across roots.

## Failure modes, cost and compatibility

Malformed headers fail with 400 before the handler; serialization or
configuration errors fail with 500 without echoing values; SSR failures fall
back to client rendering unless `strict` is selected. Flash and error data are
consumed by the next rendered page, so a crash during that render loses them
(as upstream). Per-request work is proportional to the props selected; shared
props are resolved on every page response by design.

Only protocol v3 (clients 3.x) is supported; there is no v1/v2 mode. The public
API is `0.1.0-alpha.0` and may change before a stable release. Precognition,
automatic empty-response redirects, previous-URL storage and testing helpers
were added later (see the [guide](../guides/inertia.md#parity-matrix)).

## Status update (2026-11-07)

The Phase 9–11 work named in the status line has shipped. `@nestvexa/react`,
`@nestvexa/vue` and `@nestvexa/svelte` boot and hydrate the official clients.
`@nestvexa/vite` provides manifests, the dev server and in-process or
official-server SSR. All of this is recorded in
[ADR 0024](0024-frontend-adapters-and-ssr.md) and covered by
`tests/vite-ssr.test.ts` and the `tests/browser/inertia-*.spec.ts` suites.
