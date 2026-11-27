# Threat model

Date: 2026-11-01, updated 2026-11-06 after the
[2026-11 internal review](internal-review-2026-11.md); residual risks refreshed
against `main` on 2026-11-27.

> **INTERNAL.** This threat model was written and reviewed by the project
> itself. It is not an independent third-party review, a penetration test or a
> certification, and no ASVS level is claimed.

Scope: the implemented packages listed in the root README. Templates, helpers,
components, hooks, plugins and host policies run as trusted server code; there
is no sandbox.

## Diagrams

[Threat model diagrams](threat-model-diagrams.md) (internal, Mermaid) show the
data flows and trust boundaries for MVC, Live, Inertia, server actions,
uploads, realtime and islands, with the control and test at each crossing. The
tables below remain the reference list of boundaries.

## Assets

Private application data rendered into HTML or JSON; server-side Live state and
snapshot references; identity bindings, session cookies and CSRF tokens; uploaded
files and pending upload tokens; realtime channel contents; download payloads;
template and asset files; configuration and secrets (session, realtime HMAC);
logs and telemetry; the integrity of the browser runtime.

## Actors

Anonymous visitors; authenticated users of the same or different tenants; a
malicious cross-site page in the victim's browser; a network observer without TLS;
a user replaying old requests or tampering with markup/devtools; a compromised
browser extension; trusted template/component authors (who can make mistakes);
operators; dependency maintainers.

## Trust boundaries and controls

| Boundary                       | Attacks considered                                                                                                                   | Controls                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Browser → Live action route    | Forged/replayed actions, CSRF, cross-origin POST, unknown actions, mass assignment, prototype pollution, oversized/deep JSON         | Generated Nest routes per action; exact `Origin`; constant-time CSRF compare; JSON content type; bounded parser rejecting `__proto__`/`constructor`; identity-bound opaque snapshots with revision locks (stale → 409, replay rejected); explicit writable allowlist with validators; host `authorize` + Nest guards/pipes/interceptors/filters | `tests/live-security.test.ts`, `tests/live-protocol.test.ts`, `tests/live*.test.ts`, `tests/browser/live.spec.ts`    |
| Server state → browser markup  | XSS through state, props, child HTML, stream text, event payloads, attributes                                                        | Escaping by default; `SafeHtml` only from framework; client rejects scripts, inline handlers, executable URLs, non-HTML namespaces before morph; `nv:text`/`nv:bind` allowlists; streams text-only                                                                                                                                              | `tests/client-security.test.ts`, `tests/browser/projects.spec.ts` (`<script>` names), `tests/browser/stream.spec.ts` |
| Parent → child components      | Forged child placeholders, stub spoofing, prop injection, child mutating parent-owned values                                         | Per-render random nonce placeholders; child alias allowlist; stubs must match existing roots before any DOM change; reactive props server-owned and mutation → 409; each child has its own `$mount` authorization and snapshot                                                                                                                  | `tests/live-nesting.test.ts`, `tests/browser/nesting.spec.ts`                                                        |
| Browser-routed events          | Forged event names/payloads, fan-out storms                                                                                          | Events delivered only as registered `@OnEvent` actions with pipes and authorization; bounded counts/sizes                                                                                                                                                                                                                                       | `tests/client-events-protocol.test.ts`, `tests/live-nesting.test.ts`                                                 |
| Redirects and navigation       | Open redirect, protocol-relative/scheme URLs, script execution from swapped documents                                                | Application-relative paths only (server and client); `nv:navigate` same-origin GET, asset-signature check, scripts stripped, full-load fallback                                                                                                                                                                                                 | `tests/live-effects.test.ts`, `tests/client-events-protocol.test.ts`, `tests/browser/projects.spec.ts`               |
| Downloads                      | Token theft/replay, header injection, content sniffing                                                                               | 256-bit single-use tokens bound to identity and component, 60 s TTL, sanitized RFC 5987 filenames, `nosniff`, `CSP: sandbox`, `no-store`                                                                                                                                                                                                        | `tests/live-effects.test.ts`, `tests/uploads-http.test.ts`                                                           |
| Uploads                        | Oversize streams, spoofed MIME, polyglots, path traversal, quota exhaustion, token replay, interrupted uploads                       | Streaming byte limits, magic-byte/UTF-8 checks, executable/HTML/SVG denied, random object names, quotas and rate limits, single-use tokens bound to identity/purpose/size/hash, cleanup sweeper; scanner hook (no scanner configured by default)                                                                                                | `tests/uploads-*.test.ts`, `tests/browser/uploads.spec.ts`                                                           |
| Forms (no-JS)                  | CSRF, duplicate submit, prototype keys, type confusion, open redirects                                                               | Constant-time CSRF + Origin/Sec-Fetch-Site, input hardening before adapters, single-use submission tokens, 303 redirects to fixed paths, read-once errors without password echo                                                                                                                                                                 | `tests/forms-*.test.ts`, `tests/browser/forms.spec.ts`                                                               |
| Realtime subscriptions         | Channel guessing, stolen tokens, cross-site WebSocket hijacking, revoked users still receiving data, slow-consumer memory exhaustion | HMAC tokens bound to identity with expiry and rotation; per-channel authorization at subscribe/revalidation/delivery; exact Origin on upgrade; `revoke()`; bounded queues and connection caps; invalidation-only payloads                                                                                                                       | `tests/realtime.test.ts`, `tests/realtime-live.test.ts`, `tests/browser/realtime.spec.ts`                            |
| Inertia                        | Script-closing injection in page JSON, malformed headers, version confusion, redirect injection, cross-user props                    | v3 JSON escaping (`/`, `<`, `>`, `&`, U+2028/9); header validation (400); 409 version handling with relative locations; reserved `errors`; per-request shared props                                                                                                                                                                             | `tests/inertia-*.test.ts`, `tests/browser/inertia.spec.ts`                                                           |
| Cache                          | Cross-user leaks, poisoning via missing vary inputs, personal fragments shared                                                       | Private keys hash identity+tenant; SWR refused for private data; JSON cloning; `FragmentCache` keys only explicit inputs, renders from its own model, never stores `private` fragments by default and refuses Live snapshots/CSRF/signed props                                                                                                  | `tests/cache.test.ts`, `tests/cache-poisoning.test.ts`, `tests/cache-fragments.test.ts`                              |
| 103 Early Hints (opt-in)       | Header/Link injection, hinting per-user URLs before authorization, 1xx to clients that cannot parse it                               | `formatEarlyHint` allows only same-origin paths or `https:` URLs without Link-grammar characters (max 32); GET/HEAD over HTTP/1.1+ only; never after final headers; only public content-hashed assets are listed (`ViteAssets#earlyHints`, `NestvexaBrowserService#earlyHints`)                                                                 | `tests/early-hints.test.ts`                                                                                          |
| Query budget (development)     | Leaking SQL literals or parameters into warnings; running in production                                                              | Warnings carry the normalized statement shape only (literals and placeholders become `?`, max 200 chars), never parameters; `queryBudget()` returns a disabled hook in production                                                                                                                                                               | `tests/observability-queries.test.ts`                                                                                |
| Telemetry and devtools         | Leaking state, tokens, identities in spans/logs; devtools exposed in production                                                      | Spans carry only names/revisions/sizes; redacting logger; devtools refuses production and requires host authorization                                                                                                                                                                                                                           | `tests/observability.test.ts`                                                                                        |
| CLI → host project             | Writing outside the project, clobbering user code, partial edits                                                                     | Path confinement, conflict detection, atomic apply with rollback, checksum manifest for removal                                                                                                                                                                                                                                                 | `tests/cli.test.ts`                                                                                                  |
| Source → tarball               | Shipping tests, secrets or workspace aliases                                                                                         | `files` allowlists, packed external consumers with npm and pnpm                                                                                                                                                                                                                                                                                 | `scripts/pack.mjs`, `tests/pack-consumers/`                                                                          |
| View names → template files    | Traversal, drive/stream/UNC syntax, symlink escape, existence probing, process abort via U+10FFFF on Windows                         | Root-relative forward-slash IDs; controls, unpaired surrogates and noncharacters refused before any fs call; real-path containment; EJS includes resolved by the adapter (EJS's own `existsSync` probing is never reached)                                                                                                                      | `tests/property-view-paths.test.ts`, `tests/engine-*.test.ts`                                                        |
| Request URL → response headers | Scheme-relative `X-Inertia-Location` via `/\host`, header crashes from non-Latin-1 redirect targets                                  | Backslashes/C0 percent-encoded in request-derived locations; non-ASCII targets UTF-8 encoded; every redirect validator property-tested to stay same-origin or allowlisted                                                                                                                                                                       | `tests/property-inertia.test.ts`                                                                                     |
| Realtime broker memory         | Unbounded replay history across per-user channels                                                                                    | Replay kept for at most `replayChannels` (LRU); hub churn leak check                                                                                                                                                                                                                                                                            | `tests/property-realtime-token.test.ts`, `pnpm load`                                                                 |
| Release pipeline → npm         | Token theft, tampered or partial publication, unknown dependency inventory                                                           | Manual dispatch, full matrix, `release:check`, protected `npm-release` environment, npm trusted publishing (OIDC, no stored token) with provenance, SHA-256-verified tarballs in dependency order, CycloneDX SBOM per tarball                                                                                                                   | `.github/workflows/release.yml`, `scripts/release-publish.mjs`, `scripts/sbom.mjs`                                   |

## Residual risks and host responsibilities

- Authentication, session stores, cookie flags, TLS, proxy trust, CSP headers and
  rate limits at the edge are host-owned; the starters use illustrative guest
  sessions and must not be deployed as-is.
- **Shared state.** Live state, presence and durable jobs can be shared across
  replicas with `RedisLiveStore`, `RedisPresenceStore` and `RedisJobQueue`
  (`@nestvexa/realtime-redis`), tenant- and user-namespaced, failing closed with
  `503 STORE_UNAVAILABLE` (`tests/live-store-contract.test.ts`,
  `tests/realtime-distributed.test.ts`). They target one Redis primary: no
  Sentinel discovery, no tested failover, no Redis Cluster, and no TLS on the
  Redis connection. The default stores (`MemoryLiveStore`, `MemoryJobQueue`) are
  process memory: single process or sticky sessions, and a restart loses state
  (fail closed).
- **Still process-local.** Server-action idempotency records, rate limits and
  serial locks (`MemoryIdempotencyStore`) and pending upload tokens have no
  shared implementation, so a retried action can run twice after a restart or
  on another replica, and an upload must finish on the replica that started it.
  A download URL is served only by the replica that issued it. Cross-replica Live
  idempotent replay is tested only against the in-process Redis test double.
- Revision checks prevent replay against the same snapshot; they are not
  exactly-once business transactions. Use host idempotency and database transactions.
- Signature checks cannot rule out every polyglot upload; downloads are always
  sandboxed attachments. No malware scanner is configured by default; the
  `ClamdScanner` adapter is opt-in.
- On Windows, Node 22/24 abort the process for any filesystem path containing
  U+10FFFF (libuv). Nestvexa's own request paths refuse it; host code that joins
  request values into paths must do the same until the upstream fix ships.
- **Fuzzing.** Property-based tests (`pnpm test:property`, nightly) cover the
  server parsers and trust boundaries, and `tests/property-client-runtime.test.ts`
  fuzzes the browser runtime in real browsers (directive grammar, fragment
  safety, morph invariants, hostile replies, mounts). The React, Vue and Svelte
  adapters, island hydration and the Alpine bridge have no property or fuzz
  suite. Mutation testing (`pnpm test:mutation`) reports a score but does not
  gate.
- **Volume and slow clients.** `pnpm load` checks correctness and heap growth
  for starter-hbs, live-counter and the realtime hub in a single process; load
  across replicas is not measured. Stalled uploads are tested; slow-header and
  slow-body (slowloris) clients against the Live, actions and Inertia routes are
  not. Node's `headersTimeout`, `requestTimeout` and keep-alive limits, and edge
  rate limits, are host-owned
  ([hardening](hardening.md#slow-clients-and-server-timeouts)).
- **Executed outside unit tests.** `pnpm test:services` has run against real
  Redis 7, SeaweedFS (S3 API) and ClamAV, including a two-replica browser run
  ([services evidence](../implementation/services-evidence-2026-11-05.json)).
  Real AWS S3 has not been exercised.
- **Not done.** Independent security review (an owner action), a manual
  screen-reader pass, and fuzzing of the adapters named above.

See [hardening](hardening.md), [ASVS traceability](asvs-traceability.md), the
[security design review](security-design-review.md) and the
[2026-11 internal review](internal-review-2026-11.md).
