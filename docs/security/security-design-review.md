# Security design review (internal)

Date: 2026-11-07. Reviewed tree: branch `worktree-agent-a5a2bc8a3e7823f9c`
from `main` at `acf4168`. Reviewer: an internal coding-agent role working on
the security area. Result: **NOT READY FOR 1.0. Release blockers remain**
(listed below).

> **This is an INTERNAL review, not an independent one.** The project that
> wrote the code also wrote this review, with the same blind spots. It does not
> satisfy the independent-review gate for 1.0: `security-review.json` needs a
> reviewer with `independent: true`, and only the owner can supply one (see
> [release evidence formats](../release/evidence-formats.md)). No penetration
> test, external audit or ASVS level or certification is claimed.

This replaces the preliminary design review of 2026-10-27 (its text stays in
git history). That version predates Inertia, uploads, server actions,
realtime, islands, the framework adapters and the cache. Findings of the
adversarial review of 2026-11-05/06 are in the
[internal review](internal-review-2026-11.md), and ASVS 5.0 identifiers are
mapped in the [ASVS traceability](asvs-traceability.md).

## Method

The review read the request-facing code of every package against the
[threat model](threat-model.md) and checked each design control below against
the tests that exercise it. This round added negative tests for partial-reload
re-authorization, CORS, SSRF, cache poisoning, request coalescing, Alpine
directive injection and hostile Vue/Svelte page props. Depth: the packages
named in a row were read for this review; the rest of the evidence comes from
existing suites, which this review re-ran only where it changed code (see the
round 4 report, `docs/implementation/agent-reports/security-round4.md`).

## Design controls by boundary

| Boundary                    | Design control (current code)                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                 | Residual risk and owner                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views and engines           | Interpolation escapes by default; raw output is explicit trust. View IDs are normalized, contained by realpath and refuse controls, surrogates and noncharacters before any filesystem call. Templates and helpers are trusted code                                                                           | `tests/views.test.ts`, `tests/property-view-paths.test.ts`, engine suites                                                                                | Escaping does not validate URL schemes or CSS. Host must never compile user templates                                                                                           |
| Live protocol               | Bounded JSON envelope (64 KiB, 5,000 nodes, depth 16); opaque snapshot tokens bound to the host identity binding; revision locking; exact-origin and session CSRF before any handler; explicit action and writable-state registries; `$sync` authorized separately; required `authorize` callback             | `tests/live-security.test.ts`, `tests/live-protocol.test.ts`, `tests/property-live-protocol.test.ts`, `tests/cors-posture.test.ts`                       | In-memory store is single-process. Revisions are not business idempotency. `@Locked` is not authorization                                                                       |
| Browser client              | Closed data-only directive grammar (no expressions); HTML-only fragments; response identity and revision checks; same-origin URL policy for `nv:navigate`, `nv:bind` URL attributes and redirects; bounded transport                                                                                          | `tests/client-security.test.ts`, `tests/client-directive-grammar.test.ts`, `tests/client-csp.test.ts`                                                    | Not property-tested (morph invariants). Host markup is trusted                                                                                                                  |
| Alpine adapter              | Ships the CSP build (no eval). Alpine runs only inside `nv:ignore` subtrees through the public `$live` magic. Server-rendered data reaches the DOM as escaped text or attribute values and never as markup, so it cannot create `x-*`, `@` or `nv:*` attributes                                               | `tests/alpine.test.ts`, `tests/alpine-start.test.ts`, `tests/browser/alpine-injection.spec.ts` (new)                                                     | Interpolating data into an Alpine expression attribute in a template (`x-data="{ n: '{{name}}' }"`) is unsafe: HTML escaping is undone by the parser. Pass data through `$live` |
| Inertia                     | Page JSON escaped for script embedding (`/`, `<`, `>`, `&`, U+2028/9). Every request (full, partial, deferred) runs the host guards and handler again; props a handler withholds are never resolved. Request-derived locations encode `\` and controls. JSON responses vary on every content-selecting header | `tests/inertia-security.test.ts`, `tests/property-inertia.test.ts`, `tests/inertia-reauthorization.test.ts` (new), `tests/cache-poisoning.test.ts` (new) | Authorization of each prop is the host handler's job; factories run at resolution time and must re-check their own policy                                                       |
| SSR gateway                 | Fixed target from host configuration (`http(s)` only, no credentials, query or fragment); never follows redirects; bounded timeout and body (stream cancelled past the limit). In-process renderers load only built bundles                                                                                   | `tests/ssrf.test.ts` (new), `tests/vite-ssr.test.ts`                                                                                                     | A compromised SSR server can still return hostile markup into the document; run it on loopback                                                                                  |
| Vue, Svelte, React adapters | Rendering through the official frameworks, which escape text and attribute values. The page registry resolves only listed components                                                                                                                                                                          | `tests/browser/inertia-hostile-props.ts` (new, Vue and Svelte: SSR, hydration, client-only mount, Inertia visit), adapter suites                         | **Vue and Svelte do not filter URL schemes**: an app binding a prop to `href` must allowlist schemes (as the examples' `safeHref` does). React blocks `javascript:` URLs itself |
| Server actions              | Fixed admission order: method, Origin, media type, length, identity, constant-time CSRF, rate limit, body shape, idempotency key, host authorization                                                                                                                                                          | `tests/actions-security.test.ts`, `tests/cors-posture.test.ts`                                                                                           | IR-2026-10 (P3, open): large arrays allocate before the node budget check, bounded by `maxBodyBytes`                                                                            |
| Uploads and S3              | CSRF and origin before parsing; streaming byte limits; content sniffing with allowlists; random storage keys; sandboxed attachment downloads. S3 requests go only to the configured endpoint with generated keys; `node:http` never follows redirects                                                         | `tests/uploads-http.test.ts`, `tests/uploads-validation.test.ts`, `tests/property-uploads*.test.ts`, `tests/ssrf.test.ts`                                | No default malware scanner; quotas and pending tokens are per process                                                                                                           |
| Realtime                    | HMAC channel tokens bound to identity and expiry with rotation; exact channel grammar; WebSocket upgrades check the configured Origin; bounded replay channels                                                                                                                                                | `tests/realtime-hub.test.ts`, `tests/property-realtime-token.test.ts`                                                                                    | SSE query tokens can reach access logs                                                                                                                                          |
| Cache                       | Private keys hash tenant and binding (SHA-256) and refuse malformed bindings; single-flight coalescing is per key, so concurrent misses for different identities never share a value or a failure; callers get private copies; stale-while-revalidate refused for private entries                             | `tests/cache.test.ts`, `tests/cache-poisoning.test.ts` (new)                                                                                             | Completeness of `vary` inputs is the host's job                                                                                                                                 |
| CORS                        | No package sets CORS headers. The exact-origin check on every state-changing route holds even when the host enables reflected credentialed CORS                                                                                                                                                               | `tests/cors-posture.test.ts` (new); [CORS posture](cors.md)                                                                                              | Host CORS on its own routes                                                                                                                                                     |
| Outbound network            | Only configured targets: SSR server, S3 endpoint, ClamAV, Redis. A static inventory test fails on any new network primitive in package sources                                                                                                                                                                | `tests/ssrf.test.ts` (new)                                                                                                                               | Host code                                                                                                                                                                       |
| Observability and telemetry | Opt-in hooks only; nothing sent anywhere by default; fixed span attributes without state, identity, tokens, HTML or messages; redacting logger; devtools refuse production and need host authorization                                                                                                        | `tests/observability*.test.ts`, `tests/devtools-*.test.ts`; [telemetry policy](telemetry.md)                                                             | Host export pipelines and retention                                                                                                                                             |
| Supply chain                | Lockfile with release-age delay; CycloneDX SBOM per tarball; license allowlist (`pnpm audit:licenses`); secret scanning (`pnpm secrets:scan` plus TruffleHog pinned to a commit in CI); weekly `pnpm audit`. Provenance is configured in `release.yml` but **has never been exercised**                       | `tests/supply-chain-scripts.test.ts` (new), `scripts/sbom.mjs`, `.github/workflows/ci.yml`                                                               | No release published yet, so no attestation verified                                                                                                                            |

## Findings of this round

Severity scale as in the [internal review](internal-review-2026-11.md). All are
fixed with regression tests. No P0 or P1 issue was found.

| ID     | Package | Severity | Finding                                                                                                                                                                                                                                                                                                           | Fix and evidence                                                                                                                                                           |
| ------ | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR4-01 | inertia | P2       | **Cache poisoning.** JSON page responses sent `Vary: X-Inertia` only, while partial-reload, reset, error-bag, merge-intent, except-once and version headers select their content. A shared cache could store one partial reload (only the requested props) and replay it to every later Inertia visit of the URL. | `Vary` lists every content-selecting header; 409s also vary on `X-Inertia-Version`. `tests/cache-poisoning.test.ts` runs a keyed shared-cache model on Express and Fastify |
| SR4-02 | cache   | P2       | **Key collision across identities.** Private keys hash the binding as UTF-8, which replaces every unpaired surrogate with U+FFFD, so distinct malformed bindings (and a binding containing a literal U+FFFD) shared one private key.                                                                              | `cacheKey` refuses bindings with unpaired surrogates. `tests/cache-poisoning.test.ts`                                                                                      |
| SR4-03 | inertia | P3       | **Unbounded SSR responses.** `HttpSsrGateway` buffered the whole `/render` body before checking `maxResponseBytes`, and `/health` read any body size and followed redirects.                                                                                                                                      | Streams are read with a hard limit and cancelled beyond it; `/health` refuses redirects. `tests/ssrf.test.ts`                                                              |
| SR4-04 | inertia | P3       | The SSR gateway URL accepted embedded credentials, a query or a fragment.                                                                                                                                                                                                                                         | Refused at construction. `tests/ssrf.test.ts`                                                                                                                              |

Fixed separately on `main` during this round (not by this review's branch):
in `@nestvexa/uploads` (`packages/uploads/src/service.ts`), a truncated
multipart body made busboy emit `error` twice. The second emission was
uncaught and crashed the process, so a single request could take the host
down (DoS). The parser and part-stream error listeners now stay attached, and
cleanup waits for queued writes. The regression test is part of that change on
`main`.

## Release blockers

| Blocker                                                                                                                    | Owner                   |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Independent security review recorded in `security-review.json` with an `independent: true` reviewer                        | Owner only              |
| First release through `release.yml`, with its provenance attestation and SBOM verified after publication                   | Owner and release role  |
| Complete release matrix (`release-matrix.json`) recorded for the release candidate                                         | Release role            |
| ASVS 5.0 applicability assessment for every chapter (the current mapping is partial; missing entries are not inapplicable) | Security role, reviewed |
| No fuzzing of the browser runtime, morph invariants or framework adapters; no mutation testing                             | Security role           |
| Real Redis, S3 and ClamAV runs are outside this review (protocol fakes only)                                               | Services role           |
| Durable business idempotency is host-owned: Live revisions and action idempotency keys are not exactly-once effects        | Host, documented        |

These are unmet gates, not demonstrated exploits. A concrete exploit, if found,
gets its own finding with a reproduction and a regression test.

## Host responsibilities

Hosts own authentication, sessions and cookie policy, TLS and proxy trust, CSP
and security headers, CORS on their own routes, resource-level authorization
inside handlers and prop factories, scheme allowlists for URLs bound in Vue and
Svelte pages, export and retention of any telemetry they enable, and
deployment hardening ([hardening](hardening.md)). A framework option cannot
install those guarantees.
