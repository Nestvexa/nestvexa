# Internal adversarial security review — 2026-11

Dates: 2026-11-05 to 2026-11-06. Reviewed tree: branch
`worktree-agent-a5133b98560ed2323` from `d4c4cec`. Reviewer: an internal
coding-agent role working on the security/QA/release area.

> **This is not an independent third-party review.** It was performed by the
> same project that wrote the code, with the same blind spots. It does not
> satisfy the independent-review gate for 1.0 (`security-review.json` requires a
> reviewer with `independent: true`; see
> [release evidence formats](../release/evidence-formats.md)). No ASVS level or
> certification is claimed.

## Method

1. **Property-based fuzzing** (fast-check 4.10.2) of every parser and trust
   boundary, with an independent reference model where one exists (Live byte,
   node and depth budget; RFC 9110 ranges; JSON admission). Hostile generators
   include traversal spellings, Windows device/stream/UNC syntax, controls, bidi
   and invisible characters, unpaired surrogates, noncharacters, prototype keys
   created as own properties via `JSON.parse`, accessors, sparse arrays and
   class instances. Suites: `pnpm test:property` (also in `test:security`).
2. **HTTP-level fuzzing** of the multipart and raw upload routes over a real
   Express server (hostile part headers, boundaries, truncation).
3. **Source review** of each package's request-facing code, the
   threat-model controls and the existing negative tests.
4. **Load and memory checks** (`pnpm load`): correctness under concurrency and
   heap growth of the Live store and realtime hub.

Depth per package is stated below: **fuzzed** (property suite), **read**
(source reviewed for this report), **spot-checked** (key functions only).

## Findings

Severity scale (same as [evidence formats](../release/evidence-formats.md)):
P0 default-configuration compromise or cross-tenant exposure; P1 exploitable
with plausible configuration; P2 defense-in-depth gap or DoS needing unusual
conditions; P3 hardening. Every finding below is **fixed** with a regression
test unless marked otherwise. No P0 or P1 issue was found.

| ID         | Package                     | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                         | Fix and evidence                                                                                                                                                                                                                           |
| ---------- | --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IR-2026-01 | views, engine-\*            | P2       | **Process abort on Windows.** Node 22/24 (libuv `idna.c` assertion `code_point < 0x10FFFF`) terminates the whole process for any fs call whose path contains U+10FFFF. View IDs, partial targets and include references reached `realpath`/`stat` with that character, so a host that renders a request-chosen view name could be crashed by one request.                                                       | View IDs refuse `\p{Cc}`, `\p{Cs}` and noncharacters before any fs call (`normalizeViewId`, HBS `viewId`). `tests/property-view-paths.test.ts` (crash reproduced as worker exit `0xC0000409` before the fix).                              |
| IR-2026-02 | engine-ejs                  | P2       | **fs probes before containment.** EJS's built-in `include` calls `fs.existsSync(resolve(dir, reference))` before the adapter's `includer` hook runs. Data-driven includes (`include(name)`) gave an existence oracle outside the root, UNC references (`\\host\share\x`) made Windows contact a remote SMB host (credential exposure risk), and U+10FFFF aborted the process.                                   | The adapter now provides its own `include` local (same semantics: aliases, `/x`, relative, shallow-copied locals + data); EJS's path fails closed. Upstream probing confirmed separately; regression asserts `existsSync` is never called. |
| IR-2026-03 | inertia                     | P2       | **Request URL to scheme-relative location.** The 409 version-mismatch `X-Inertia-Location` reused the raw request URL after collapsing leading `/`. A path such as `/\evil.example` survives, and browsers / the official client's `new URL()` resolve it to `https://evil.example/`. Browsers normalise `\` before sending, so exploitation needs a non-browser hop or proxy; still a header-integrity defect. | Backslashes and C0 controls are percent-encoded before the slash collapse. `tests/property-inertia.test.ts` asserts every request-derived location resolves same-origin.                                                                   |
| IR-2026-04 | inertia                     | P3       | Redirect targets with non-ASCII characters were returned unchanged; Node rejects header values above Latin-1, turning `redirect('/products/日本')` into a 500.                                                                                                                                                                                                                                                  | Non-ASCII is UTF-8 percent-encoded (ASCII byte-for-byte unchanged; lone surrogates refused; absolute allowlisted URLs re-serialised by WHATWG URL).                                                                                        |
| IR-2026-05 | uploads                     | P3       | Unpaired UTF-16 surrogates passed `parseClientFilename` and made `contentDisposition` throw `URIError` (500 on download); truncation to 255 code units could split a pair and throw the same way.                                                                                                                                                                                                               | Client names with lone surrogates are refused; header encoding substitutes U+FFFD and truncates by code point. `tests/property-uploads.test.ts`.                                                                                           |
| IR-2026-06 | live                        | P3       | `downloadLive` content types were checked with a corrupted character class: a `$&` replacement artifact pasted a comment into the regex, admitting spaces, `*`, `,` and extra `/` (`text/html, text/plain`). Header injection was not possible (no CR/LF), and downloads stay sandboxed attachments.                                                                                                            | Restored the RFC 6838 restricted-name class. Regression lists previously accepted values.                                                                                                                                                  |
| IR-2026-07 | live                        | P3       | Live download filenames kept lone surrogates (500 on the download GET) and bidi/invisible characters (`invoice<U+202E>fdp.exe` spoofing).                                                                                                                                                                                                                                                                       | `safeFilename` substitutes U+FFFD, drops C1/bidi/invisible characters and truncates by code point; header builder re-checks. `tests/property-live-protocol.test.ts`.                                                                       |
| IR-2026-08 | realtime                    | P2       | `MemoryRealtimeBroker` bounded replay history per channel but kept it for every channel ever published; per-user or per-record channels grew memory without bound (100 events × distinct channels).                                                                                                                                                                                                             | History kept for at most `replayChannels` (default 10,000, LRU by publish). Property test plus the 20,000-connection hub churn in `pnpm load` (heap growth 0.60 MiB).                                                                      |
| IR-2026-09 | observability               | P3       | `redact()` assigned keys with `output[key] = …`; an own `__proto__` key (from `JSON.parse` of a body) replaced the copy's prototype and disappeared from logs.                                                                                                                                                                                                                                                  | Own data properties via `defineProperty`; property test over arbitrary nesting.                                                                                                                                                            |
| IR-2026-10 | actions                     | P3, open | `inspectJsonInput` pushes all array elements onto its work stack before the node budget is checked on pop, so one large array allocates stack entries proportional to its length (bounded by the host body-size limit, default 1 MiB).                                                                                                                                                                          | Not changed (would alter which problem is reported first). Mitigated by `maxBodyBytes`; documented here. Candidate for a pre-push length check.                                                                                            |
| IR-2026-11 | uploads/download (platform) | P3, open | U+10FFFF in any host code path that reaches `fs` aborts Node on Windows. Nestvexa's own request paths are now guarded (IR-2026-01; upload storage keys are ASCII-only), but host code that joins request values into paths remains exposed until the upstream libuv fix ships.                                                                                                                                  | Documented in [hardening](hardening.md). Track the Node/libuv release and drop the note once fixed upstream.                                                                                                                               |

## Trust boundaries by package

### `@nestvexa/live` (fuzzed, read)

- **Envelope parser** (`parseLiveRequest`, `cloneState`): property-tested
  against an independent model; acceptance is exactly
  `bytes ≤ 65,536 ∧ nodes ≤ 5,000 ∧ depth ≤ 16`, including at the byte
  boundary with multi-byte and lone-surrogate strings. Only `LiveProtocolError`
  is thrown for arbitrary in-process values (Maps, typed arrays, boxed values,
  null prototypes, sparse arrays). Prototype keys at any depth of `updates` or
  `input` are rejected without polluting `Object.prototype`; accessors are never
  evaluated; the returned copy is frozen and detached.
- **Snapshot tokens**: only canonical unpadded base64url of 32 bytes; alternate
  spellings of the final sextet, padding and other lengths rejected.
- **Text-stream request**: exactly four keys; arbitrary values → 400 only.
- **Effects**: IR-2026-06/07 fixed. Redirects (`safeRedirectPath`) never resolve
  off-origin for any generated input.
- **State store under load**: 4,673 serial actions over 400 sessions for
  3 minutes, all 201, heap slope 0.05 MiB/min (no snapshot retention leak).
- Unchanged residual risks: in-process store (single process or sticky
  sessions), revision checks are not business idempotency.

### `@nestvexa/client` (read in prior reviews; not re-fuzzed)

Covered by the existing browser corpus (`tests/client-security.test.ts`,
HTML-only fragments, URL policy). This review added no client tests; the
property suite targets server parsers. Gap: no property test of the morph
invariants (QA-056 lists "idempotent morph invariants").

### `@nestvexa/views` and engines (fuzzed, read)

- `normalizeViewId` / `resolveTemplateReference`: every accepted ID resolves
  inside any root (1,000 generated cases each, including `..` spellings,
  fullwidth dots, U+2025, drive/stream/UNC syntax).
- All four engines (HBS, EJS, Pug, Nunjucks): no view name, partial alias or
  template include renders a secret placed next to the root, in the parent, or
  in a sibling directory sharing the root's prefix. IR-2026-01/02 fixed.
- Windows trailing-dot/space segments (`.. `) were tested and do not traverse.

### `@nestvexa/realtime` (fuzzed, read)

- Tokens: any single-character substitution, deletion or insertion is
  rejected; tokens are bound to the identity hash and expiry; rotation verifies
  old secrets, unrelated secrets never verify; arbitrary input yields only
  `RealtimeTokenError`. Channel grammar is exact.
- Hub: 20,000 connect/close cycles leave zero connections and zero broker
  subscriptions. IR-2026-08 fixed.

### `@nestvexa/uploads` (fuzzed incl. HTTP, read)

- Filenames, percent-encoded name headers, `Content-Disposition`, Range,
  upload references, storage keys and the strict UTF-8 text validator
  (chunking-invariant) are property-tested.
- Multipart over HTTP: 60 random bodies (hostile names, `filename*`, quotes,
  CRLF, odd boundaries, truncation, prototype field names) and 60 raw-upload
  name headers produced no 5xx; files were accepted only with valid names and
  CSRF first; temporary files never leaked.
- IR-2026-05 fixed. Unchanged: polyglots, no default malware scanner, per-process
  quotas.

### `@nestvexa/actions` (fuzzed, read)

- `inspectJsonInput` agrees with a reference model of depth, nodes and
  prototype keys; iterative (50,000-deep JSON does not overflow); non-JSON and
  accessors rejected. Admission order (method, Origin, media type, length,
  identity, constant-time CSRF, rate limit, body shape, idempotency key, host
  authorization) was re-read in `runtime.ts`.
- `toJsonSafe` never throws for arbitrary output; idempotency fingerprints are
  key-order independent. IR-2026-10 open (P3).
- `isSafeRedirect` never yields off-origin targets.

### `@nestvexa/forms` (fuzzed, read)

Bracket/dotted flat bodies reassemble exactly into the submitted structure;
hostile keys throw only `FormInputError` and never pollute `Object.prototype` or
`Array.prototype`; hardened output re-hardens unchanged.

### `@nestvexa/i18n` (fuzzed, read)

ICU subset parser throws only `I18nError` and terminates for arbitrary input;
nesting limit is exact; quoted literals round-trip; interpolated values are
fully escaped with escaping on while trusted catalog text is untouched; `select`
never consults prototype members; accessor params are not invoked;
Accept-Language is bounded to 32 entries; duplicate cookies are ignored.

### `@nestvexa/inertia` (fuzzed, read)

Headers on non-Inertia requests are ignored; on Inertia requests they either
400 or yield bounded, prototype-safe prop paths; repeated headers are
malformed. Every redirect validator (Inertia, Live, actions, `back()`) and
request-derived location resolves same-origin or to an allowlisted origin and
is header-safe. Script-embedded page JSON never contains `<`, `>`, `&`, `/`
(unescaped) or U+2028/9 and parses back losslessly. IR-2026-03/04 fixed.

### `@nestvexa/core`, `nestvexa` (spot-checked)

Config rejects unknown/accessor/prototype hazards (existing tests). The asset
host serves an allowlisted snapshot only. No new findings.

### `@nestvexa/vite` (spot-checked)

The static middleware looks request paths up in a startup index and never joins
them onto the filesystem, so traversal and IR-2026-01 do not apply. The SSR
gateway and CDN base URLs come from host configuration only.

### `@nestvexa/cache` (spot-checked)

Private keys hash `tenant \n binding`; tenant cannot contain a newline, so
cross-identity key collisions were not found. SWR refused for private data
(existing tests).

### `@nestvexa/observability` (fuzzed, read)

IR-2026-09 fixed. Devtools refuse production (existing tests).

### `@nestvexa/islands`, `react`, `vue`, `svelte`, `alpine`, `ui` (spot-checked)

Island props are JSON in escaped attributes; adapters render through official
frameworks. Not fuzzed in this review.

### `@nestvexa/offline`, `flags`, `ai`, `cli` (spot-checked)

Draft scopes are HMACs with ≥ 32-byte secrets; flag rollout buckets hash flag +
identity; AI providers are host-supplied (no built-in outbound HTTP); CLI writes
are confined to the project root. **SSRF (SEC-029):** no package fetches a
request-controlled URL; outbound URLs (Inertia SSR, S3 endpoint, ClamAV, Redis,
CDN base) come from host configuration.

## Supply chain and release (read)

Lockfile with `minimumReleaseAge: 1440`, exact pins for new tooling
(fast-check 4.10.2, autocannon 8.0.0), CycloneDX 1.6 SBOM per tarball,
SHA-256-verified tarballs, npm trusted publishing with provenance from a
protected environment, Dependabot without auto-merge, CODEOWNERS on release
paths. Workflow inputs reach shells only through environment variables.

## What this review did not do

No independent tester, no black-box penetration test of a deployed host, no
Linux run in this session, no real Redis/S3/ClamAV, no fuzzing of the browser
runtime or framework adapters, no mutation testing, and no formal ASVS L2
applicability assessment. Load figures were recorded on a saturated shared
Windows host (100% CPU from parallel work) and are advisory; correctness and
memory results are not host-sensitive.
