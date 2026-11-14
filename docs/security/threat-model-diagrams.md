# Threat model diagrams

Date: 2026-11-14. **Internal document** written by the project from the source
code and tests in this repository. It is not an independent or third-party
review and claims no certification. It complements the tables in the
[threat model](threat-model.md) and the [security guide](guide.md).

Each diagram is a data-flow diagram. Every `subgraph` is a trust zone, and every
arrow that leaves a zone crosses a trust boundary. The table under each diagram
lists the controls at each crossing and the test that proves them. Names in
`code` are the real identifiers, error codes and headers in the packages.

Trust zones used in every diagram:

- **Browser (untrusted)**: everything the client sends, including markup that
  devtools or an extension can edit, headers, bodies and replayed requests.
- **Host application (trusted code)**: Nest, the host's guards and
  `resolveIdentity`/`authorize` policies, templates, helpers and components.
  Nestvexa has no sandbox for trusted code.
- **Nestvexa runtime (trusted, enforcing)**: the generated routes and the
  admission checks that run before host code.
- **Infrastructure (trusted, shared)**: state stores, Redis, object storage, the
  SSR server and the filesystem. Content read back from them is still validated.

## 1. MVC: controller and view engine render

```mermaid
flowchart LR
  subgraph B["Browser (untrusted)"]
    U["User agent: GET page / POST no-JS form"]
  end
  subgraph H["Host application (trusted code)"]
    G["Nest guards, pipes, interceptors"]
    C["Controller returns a view model"]
    VC["View composers: per-request context, never stored"]
  end
  subgraph N["Nestvexa runtime"]
    CP["copyViewModel: null-prototype copy, no accessors, no prototype keys, bounded"]
    E["HbsEngine.render: escaping by default, SafeHtml only from trusted code, helpers locked after first render, no async helpers"]
    TR["TemplateRoot: root-relative view ids, controls and surrogates refused, real-path containment, size cap"]
    EP["ViewErrorPageFilter: fixed status/title model in production"]
    F["@nestvexa/forms: csrfToken/verifyCsrf, single-use submission tokens, 303 to fixed paths"]
  end
  subgraph I["Infrastructure"]
    FS[("Template files: read-only deploy, outside upload dirs")]
  end
  U -->|"request: path, query, body, cookies"| G
  G --> C
  C --> VC --> CP --> E
  E -->|"view id"| TR -->|"resolved real path"| FS
  E -->|"escaped HTML"| U
  U -->|"POST form + CSRF field + Origin"| F --> C
  C -.->|"thrown error"| EP -->|"no stack, no template path in production"| U
```

| Boundary crossing            | Control                                                                                     | Evidence                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Request data → view model    | `copyViewModel` rejects classes, functions, cycles, accessors and `__proto__`/`constructor` | `tests/views.test.ts`, `tests/views-composition.test.ts`                             |
| View model → HTML            | Escaping by default; fragment-shaped objects and hostile `toHTML` stay escaped              | `tests/views.test.ts`, `tests/forms-view-engines.test.ts`                            |
| View name → filesystem       | Traversal, absolute, alternate separator, stream, null byte and junction escapes refused    | `tests/views.test.ts`, `tests/property-view-paths.test.ts`, `tests/security.test.ts` |
| No-JS form POST → controller | Constant-time CSRF compare, Origin/`Sec-Fetch-Site`, input hardening before adapters        | `tests/forms-hardening.test.ts`, `tests/forms-progressive.test.ts`                   |
| Server error → browser       | Production error views with a fixed model; escaped development page                         | `tests/views-error-pages.test.ts`                                                    |
| Tenant/user data → page      | Pages serve a tenant only to its members                                                    | `tests/multi-tenant-isolation.test.ts`                                               |

## 2. Live: initial render, snapshot reference, actions and state store

Live actions travel as JSON `POST` requests to `/_nestvexa/live` routes. A
realtime WebSocket or SSE message never carries state: it only tells the client
to send the same authorized `$sync` request (see diagram 6).

```mermaid
flowchart TB
  subgraph B["Browser (untrusted)"]
    DOM["Rendered root: data-nv-snapshot (opaque reference), data-nv-revision, data-nv-csrf, data-nv-realtime"]
    CL["@nestvexa/client: morph guard rejects scripts, inline handlers, executable URLs"]
  end
  subgraph N["Nestvexa runtime (LiveRuntime)"]
    M["Mount: authorize $mount, store.create(binding)"]
    A["admit(): Origin → content type → identity → CSRF → asset version → rate limit → bounded parse → store.peek(binding) → component match → known action → authorize"]
    T["Transaction: revision compare-and-set, writable allowlist + validators, reactive props server-owned"]
    R["Render: escaped HTML, per-render child placeholder nonces"]
  end
  subgraph H["Host application (trusted code)"]
    ID["resolveIdentity: binding = session + principal + tenant"]
    AZ["authorize(identity, component, action), class/method guards, pipes"]
    ACT["Component action code"]
  end
  subgraph I["Infrastructure"]
    ST[("LiveStateStore: MemoryLiveStore or RedisLiveStore")]
  end
  M --> ID
  M -->|"create entry bound to binding"| ST
  M -->|"HTML + opaque reference, Cache-Control: no-store (host)"| DOM
  DOM --> CL
  CL -->|"POST JSON: snapshot, revision, updates; x-nestvexa-csrf, x-nestvexa-asset-version, Origin"| A
  A --> ID
  A --> AZ
  A -->|"peek(token, binding)"| ST
  A --> T --> ACT
  T -->|"commit revision + 1"| ST
  T --> R -->|"JSON response: HTML, new revision, effects"| CL
```

| Boundary crossing              | Control                                                                                                                                                              | Evidence                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Browser → Live route           | `403 ORIGIN_REJECTED`, `415 CONTENT_TYPE`, `401 IDENTITY_REQUIRED`, `403 CSRF_REJECTED`, `409 ASSET_VERSION_MISMATCH` (after CSRF), `429 RATE_LIMIT` + `Retry-After` | `tests/live-admission.test.ts`, `tests/live-asset-version.test.ts`, `tests/live-request-boundary.test.ts`       |
| Request body → runtime         | Bounded JSON parser (bytes, nodes, depth), prototype keys refused, `413 PAYLOAD_TOO_LARGE`                                                                           | `tests/live-protocol.test.ts`, `tests/property-live-protocol.test.ts`                                           |
| Snapshot reference → state     | Entry readable only with its binding; every failure is `410 INVALID_SNAPSHOT`; `403 COMPONENT_MISMATCH`; `404 UNKNOWN_ACTION`; `403 ACTION_FORBIDDEN`                | `tests/live-store-contract.test.ts`, `tests/kernel-integration.test.ts`, `tests/multi-tenant-isolation.test.ts` |
| Replay and concurrency         | `409 STALE_REVISION` (runs nothing), `409 COMPONENT_BUSY`; resync cannot write state                                                                                 | `tests/live-stale-revision.test.ts`, `tests/live-store-contract.test.ts`                                        |
| Browser updates → state fields | Writable allowlist with validators, `422 STATE_LOCKED`, `409 REACTIVE_PROP_MUTATED`                                                                                  | `tests/live-writable-paths.test.ts`, `tests/property-input-admission.test.ts`, `tests/live-nesting.test.ts`     |
| Server HTML → DOM              | Client refuses scripts, inline handlers, executable URLs and foreign namespaces before morphing; strict CSP and Trusted Types                                        | `tests/client-security.test.ts`, `tests/client-csp.test.ts`, `tests/browser/alpine-injection.spec.ts`           |
| Runtime → Redis store          | Hashed tokens and bindings, versioned records validated on read, optional AES-256-GCM, `503 STORE_UNAVAILABLE` on outage                                             | `tests/live-store-contract.test.ts`                                                                             |

## 3. Inertia: page object, partial reloads, asset version and SSR

```mermaid
flowchart LR
  subgraph B["Browser (untrusted)"]
    IC["Inertia client: X-Inertia, X-Inertia-Version, X-Inertia-Partial-Data, X-XSRF-TOKEN"]
  end
  subgraph N["@nestvexa/inertia"]
    HV["Header validation: size, count, prototype segments, controls → 400"]
    SEC["security policy: Origin + X-XSRF-TOKEN on unsafe methods; page authorization"]
    VER["Version check: 409 + X-Inertia-Location = request path"]
    SER["Strict serializer: no functions, cycles, __proto__; escapes / < > & U+2028 U+2029"]
    RD["redirect/back: relative path or allowlisted origin only"]
  end
  subgraph H["Host application (trusted code)"]
    GH["Guards + handler run again for every partial or deferred reload"]
    PF["Prop factories: resolve only requested props"]
  end
  subgraph S["SSR server (separate process, trusted, untrusted output size)"]
    SSR["POST /render, GET /health"]
  end
  IC -->|"GET/POST visit"| HV --> SEC --> VER --> GH --> PF --> SER
  SER -->|"JSON page (X-Inertia) with Vary on every selecting header"| IC
  SER -->|"first visit: HttpSsrGateway, URL from config only, redirect: 'error', body cap 5 MiB"| SSR
  SSR -->|"head + body, or fallback to client render"| SER
  SER -->|"HTML document with escaped page JSON"| IC
  GH --> RD -->|"302/303 or 409 location"| IC
```

| Boundary crossing            | Control                                                                                                 | Evidence                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Request headers → adapter    | Malformed `X-Inertia-*` headers rejected with 400; non-`true` `X-Inertia` is a full page load           | `tests/inertia-security.test.ts`, `tests/property-inertia.test.ts`         |
| Unsafe visit → handler       | `403 ORIGIN_REJECTED`, `403 CSRF_REJECTED`, `403 PAGE_FORBIDDEN`                                        | `tests/inertia-security.test.ts`, `tests/kernel-transports.test.ts`        |
| Partial reload → props       | Guards and handlers re-run; withheld props never resolve                                                | `tests/inertia-reauthorization.test.ts`                                    |
| Props → page JSON / document | Script-closing corpus cannot close the page script or title; hostile props render as text in Vue/Svelte | `tests/inertia-security.test.ts`, `tests/browser/inertia-hostile-props.ts` |
| Redirect targets             | Relative or allowlisted only; foreign `Referer` never followed; request-derived locations encoded       | `tests/inertia-security.test.ts`, `tests/property-inertia.test.ts`         |
| Shared caches                | Responses vary on every content-selecting header                                                        | `tests/cache-poisoning.test.ts`                                            |
| Adapter → SSR server         | Fixed endpoint, no redirects, response size cap                                                         | `tests/ssrf.test.ts`, `tests/inertia-http.test.ts`                         |
| Cross-user data              | Props, flash and errors separate across interleaved users                                               | `tests/inertia-security.test.ts`, `tests/inertia-share-once.test.ts`       |

## 4. Server actions: typed RPC endpoint

```mermaid
flowchart LR
  subgraph B["Browser (untrusted)"]
    AC["@nestvexa/actions/client: POST JSON, x-nestvexa-csrf, idempotency key"]
  end
  subgraph N["@nestvexa/actions admission (first class guard)"]
    AD["POST only → exact Origin → application/json → declared size → identity → constant-time CSRF → rate limit → body shape/depth/size → __proto__/constructor/prototype refused → idempotency key → authorize"]
    ENV["Envelope interceptor: deadline, idempotency replay, serial lock"]
    OUT["Output schema + JSON-safe envelope"]
  end
  subgraph H["Host application (trusted code)"]
    GG["Nest global guards (run first)"]
    CG["Group class guards → method guards"]
    PI["Pipes → input schema"]
    MT["@ServerAction method on a registered @ActionGroup"]
  end
  subgraph I["Infrastructure"]
    IS[("Idempotency records: scoped and hashed")]
    JQ[("Job queue for 202 job tickets")]
  end
  AC -->|"POST /_nestvexa/actions/group/action"| GG --> AD --> CG --> ENV --> PI --> MT --> OUT -->|"JSON envelope"| AC
  ENV <-->|"key bound to tenant, subject, action, input fingerprint"| IS
  MT -.->|"long-running"| JQ
```

| Boundary crossing       | Control                                                                                                    | Evidence                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Browser → route         | Only decorated methods of registered groups exist; missing/forged/cross-session CSRF refused before guards | `tests/actions-http.test.ts` (only explicitly registered POST actions), `tests/actions-metadata.test.ts` |
| Origin and content type | Wrong or missing Origin and non-JSON bodies refused                                                        | `tests/actions-http.test.ts`, `tests/cors-posture.test.ts`                                               |
| Body → input            | Size, depth and key bounds; prototype pollution refused; input schema                                      | `tests/actions-http.test.ts`, `tests/property-input-admission.test.ts`                                   |
| Identity tokens         | Expired and tampered bearer tokens refused before any guard or handler                                     | `tests/actions-security.test.ts`                                                                         |
| Replays and duplicates  | Idempotency key reuse with different input is a conflict; duplicates in flight get 409                     | `tests/actions-http.test.ts`, `tests/actions-security.test.ts`                                           |
| Policy registry         | Origin, CSRF and authorization decided by the registered policies                                          | `tests/kernel-transports.test.ts`                                                                        |

## 5. Uploads: multipart, chunked, content checks and storage

```mermaid
flowchart TB
  subgraph B["Browser (untrusted)"]
    UP["Uploader: POST /files, POST /sessions, PUT chunks, POST complete, no-JS multipart form"]
  end
  subgraph N["@nestvexa/uploads (UploadsService)"]
    AD["Admission: identity, x-nestvexa-csrf (or CSRF field first in multipart), exact Origin, authorize(identity, purpose, op)"]
    LIM["Streaming limits: Content-Length precheck, FILE_TOO_LARGE, CHUNK_OFFSET, CHUNK_SIZE, CONTENT_ENCODING refused, quotas"]
    INS["Inspect: extension + declared MIME + magic bytes or strict UTF-8; DANGEROUS_CONTENT for executables, HTML, SVG, XML; INVALID_FILENAME"]
    TOK["Token nvu_...: single use, bound to SHA-256(binding), tenant, purpose, size, digest; TTL 15 min"]
    FIN["finalize: re-resolve identity, re-read size + SHA-256 + content (UPLOAD_TAMPERED), scanner, then commit"]
    DL["download: attachment, nosniff, CSP sandbox, CORP same-origin, no-store, single Range"]
  end
  subgraph H["Host application (trusted code)"]
    LA["Authorized Live action or CSRF-protected route calls finalize"]
    HR["Host download route checks ownership"]
  end
  subgraph I["Infrastructure"]
    TMP[("Private temp directory")]
    STO[("Local storage or S3: random keys, SigV4 on node:crypto, fixed endpoint")]
    SC[("Scanner: ClamdScanner (optional)")]
  end
  UP --> AD --> LIM -->|"bytes"| TMP
  LIM --> INS --> TOK -->|"token only"| UP
  UP -->|"token in form or Live field"| LA --> FIN
  FIN --> SC
  FIN -->|"put"| STO
  UP -.->|"direct: true, presigned PUT to the bucket"| STO
  HR --> DL -->|"stream"| UP
  DL --> STO
```

| Boundary crossing            | Control                                                                                                                                  | Evidence                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Browser → upload routes      | Missing CSRF, foreign Origin, unknown or forbidden purposes and other identities refused (`404 UPLOAD_NOT_FOUND`, no oracle)             | `tests/uploads-http.test.ts`                                                                       |
| Byte stream → temp file      | Declared and actual size limits, content codings refused, chunk order/offset/digest checks                                               | `tests/uploads-http.test.ts`, `tests/property-uploads-http.test.ts`                                |
| File content → accepted type | Declared MIME and magic bytes; executables and markup denied even when renamed; traversal and double extensions refused                  | `tests/uploads-validation.test.ts`, `tests/uploads-http.test.ts`, `tests/property-uploads.test.ts` |
| Quotas                       | Per-identity, per-tenant and per-process file and byte quotas                                                                            | `tests/uploads-limits.test.ts`, `tests/uploads-http.test.ts`                                       |
| Token → stored object        | Single-use finalize, expiry sweep, tamper detection                                                                                      | `tests/uploads-http.test.ts`                                                                       |
| Service → S3                 | SigV4 against AWS test vectors; every object, presigned and download URL stays on the configured host; no redirects followed             | `tests/uploads-s3.test.ts`, `tests/ssrf.test.ts`                                                   |
| Stored file → browser        | RFC 5987 names, attachment, `nosniff`, sandbox CSP                                                                                       | `tests/uploads-http.test.ts`, `tests/live-effects.test.ts`                                         |
| Scanner                      | Infected files blocked, `requireScan` needs a configured scanner; `ClamdScanner` tested against a protocol fake only (no real clamd run) | `tests/uploads-s3.test.ts`                                                                         |

## 6. Realtime: channels, tokens, broker and backpressure

```mermaid
flowchart LR
  subgraph B["Browser (untrusted)"]
    RC["Realtime client: one connection for all tokens"]
  end
  subgraph N["@nestvexa/realtime"]
    SG["RealtimeService.sign: keeps channels authorizeChannel allows; HMAC token with expiry (tokenTtlMs 15 min)"]
    UPG["WebSocket upgrade: exact Origin, resolveUpgradeIdentity; SSE/poll: token in query"]
    HUB["RealtimeHub: verify HMAC + binding + expiry; authorizeChannel at subscribe, every revalidateMs, before delivery"]
    LIM["Limits: maxConnections, maxConnectionsPerIdentity, subscribesPerMinute, publishesPerMinute; queueLimit 64 and WebSocket buffer cap → slow-consumer close"]
  end
  subgraph H["Host application (trusted code)"]
    LV["Live render embeds data-nv-realtime"]
    PUB["publish(channel, data ≤ 16 KiB public JSON)"]
    POL["authorizeChannel, revoke(binding), closeChannel(channel)"]
  end
  subgraph I["Infrastructure"]
    BR[("Broker: MemoryRealtimeBroker or RespRealtimeBroker over Redis (no TLS: private network)")]
  end
  LV --> SG -->|"token in markup"| RC
  RC -->|"/ws, /sse, /poll + token"| UPG --> HUB
  HUB --> POL
  PUB --> BR -->|"fan-out to every replica"| HUB
  HUB --> LIM -->|"invalidation event only"| RC
  RC -.->|"authorized $sync through Live admission (diagram 2)"| LV
```

| Boundary crossing       | Control                                                                                         | Evidence                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Token → subscription    | Stolen tokens, unauthorized channels and connection floods refused; token expiry closes         | `tests/realtime.test.ts`, `tests/realtime-hub.test.ts`, `tests/property-realtime-token.test.ts`         |
| WebSocket upgrade       | Subscriptions only from the configured Origin                                                   | `tests/realtime.test.ts`                                                                                |
| Long-lived connection   | Re-authorization before delivery after the revalidation window; identity changes close it       | `tests/realtime.test.ts`, `tests/realtime-hub.test.ts`                                                  |
| Kernel identity         | Token signed for one user or tenant refused for another                                         | `tests/kernel-transports.test.ts`, `tests/multi-tenant-isolation.test.ts`                               |
| Backpressure            | Slow consumers closed, not buffered; replay bounded by `replayChannels`                         | `tests/realtime.test.ts`, `tests/realtime-distributed.test.ts`, `tests/property-realtime-token.test.ts` |
| Event → component state | Channels signed only when authorized; refresh is a read-only `$sync` through admission          | `tests/realtime-live.test.ts`, `tests/live-refresh.test.ts`                                             |
| Broker ↔ Redis          | Cross-replica fan-out and presence (in-process RESP double; real Redis in `pnpm test:services`) | `tests/realtime-distributed.test.ts`                                                                    |

## 7. Islands: signed props and hydration

```mermaid
flowchart LR
  subgraph BT["Build (trusted)"]
    MF["islandsVitePlugin: islands-manifest.json in .vite/, not served; bundled into the client"]
  end
  subgraph N["@nestvexa/islands (server)"]
    REG["IslandRegistry: known ids only; props plain bounded JSON, closed schema, secret-like keys refused"]
    MK["Markup: props HTML-escaped into data-nv-props; optional data-nv-props-token v1.iat.exp.hmac"]
    SSRR["Optional SSR renderer; failure → fallback markup"]
    VP["verifyProps(id, propsJson, token): changed, foreign, forged or expired → IslandError"]
  end
  subgraph B["Browser (untrusted)"]
    LD["createIslands: id allowlist from bundled manifest, framework match, props size + schema, bundle path from manifest only"]
    ISL["Island component (trusted code, public props)"]
  end
  subgraph H["Host application (trusted code)"]
    SA["Server action receiving context.signed: verify, then authorize again"]
  end
  MF --> LD
  REG --> MK --> SSRR -->|"HTML"| LD
  LD -->|"import from manifest bundle path; SRI when configured"| ISL
  ISL -->|"signed props sent back"| SA --> VP
```

| Boundary crossing           | Control                                                                                                      | Evidence                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Server props → markup       | Escaped JSON, bounded plain values, closed schemas, secret-like keys refused                                 | `tests/islands.test.ts`                                                   |
| Signed props → server       | Tampered, foreign, expired and unsigned tokens rejected                                                      | `tests/islands.test.ts`                                                   |
| Markup → module import      | Ids outside the build-time allowlist load nothing; manifest framework, size, schema and bundle path enforced | `tests/islands-client.test.ts`                                            |
| Manifest → bundle paths     | Scheme-relative, absolute, `..` and non-`.js` paths rejected                                                 | `tests/islands.test.ts`, `tests/islands-vite.test.ts`                     |
| Asset bytes → browser       | SHA-384 integrity and `crossorigin` on production tags when configured                                       | `tests/vite-integrity.test.ts`, `tests/assets-integrity.test.ts`          |
| Hydration in a real browser | Islands mount once, deferral strategies load chunks only when due                                            | `tests/browser/islands.spec.ts`, `tests/browser/islands-deferral.spec.ts` |

## What these diagrams do not show

- Host-owned controls: authentication, session cookies, TLS termination, proxy
  trust, CSP headers and edge rate limits ([hardening](hardening.md),
  [CSP and headers](../deployment/csp-and-headers.md)).
- Release and supply chain flows (see the threat model table rows for
  "Source → tarball" and "Release pipeline → npm").
- Residual risks listed in the [threat model](threat-model.md#residual-risks-and-host-responsibilities).
