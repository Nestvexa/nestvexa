# Live protocol reference (`nestvexa-live/1`)

The exact wire contract between the browser runtime (or any other client) and the
generated Live routes of `@nestvexa/live`. The [Live protocol guide](../guides/live-protocol.md)
explains the trust model; this page lists the shapes, codes and limits. Decisions are
recorded in [ADR 0002](../adr/0002-live-protocol.md) and
[ADR 0031](../adr/0031-live-protocol-evolution-and-action-replay.md).

## Routes

For each registered component `<name>` under the endpoint (default `/_nestvexa/live`,
behind any Nest global prefix):

| Route                                        | Purpose                                            | Host authorization |
| -------------------------------------------- | -------------------------------------------------- | ------------------ |
| `POST <endpoint>/<name>/<action>`            | Run a registered `@Action` (its id)                | `<action>`         |
| `POST <endpoint>/<name>/_sync`               | Apply writable model updates without an action     | `$sync`            |
| `GET <endpoint>/<name>/_download/<token>`    | Fetch a single-use attachment created by an action | token + identity   |
| Host route calling `LiveRuntime.mount(Type)` | Initial render; never a generated route            | `$mount`           |

Startup fails (during module compilation) when a host controller route of the same
method overlaps one of these paths, including `:param` and wildcard routes; versioned
host routes are skipped. Duplicate component names or action routes across
registrations fail too.

## Request

`Content-Type: application/json` (optionally `; charset=utf-8`), `Origin` equal to the
configured origin, `x-nestvexa-csrf` equal to the identity CSRF token.

```json
{
  "protocol": "nestvexa-live/1",
  "requestId": "d85e7c20-72ac-4e71-8baf-210dbe79e912",
  "snapshot": "<43-character base64url state reference>",
  "revision": 3,
  "updates": { "query": "nest" },
  "input": { "id": 42 }
}
```

- `requestId`: a UUID chosen by the client; echoed in the response and used as the
  idempotency key of `@Action({ idempotent: true })`.
- `snapshot`: the opaque server-state reference from `data-nv-snapshot`. It is a bearer
  capability bound to the identity; it is not signed browser state.
- `revision`: the revision the client rendered; any other value is `409 STALE_REVISION`.
- `updates`: top-level writable `@State` fields only. Without a synthesizer a value must
  keep its JSON kind; with one, the synthesizer decides (see [synthesizers](#typed-state)).
  For a field declared `@State({ writable: ['city', 'geo.lat'] })` the value is the whole
  object, accepted only when every difference from the stored value lies on an
  allowlisted leaf of the same JSON kind (`422 STATE_LOCKED` / `STATE_TYPE` otherwise; see
  [nested models](../guides/nested-models.md)).
- `input`: the `@ActionInput` value; absent or `null` for actions without input and `$sync`.

Unknown fields, `__proto__`/`constructor`/`prototype` keys, accessors, sparse arrays,
non-finite numbers and class instances are rejected before any component code runs.

## Response (HTTP 201)

```json
{
  "protocol": "nestvexa-live/1",
  "requestId": "d85e7c20-72ac-4e71-8baf-210dbe79e912",
  "component": { "id": "<uuid>", "name": "users-table", "revision": 4 },
  "snapshot": "<same reference>",
  "state": { "query": "nest" },
  "html": "<p>…</p>"
}
```

Optional fields: `renderless: true` (with `html: ""`), `replayed: true` (an idempotent
retry), `url`, `events`, `redirect`, `download`, `realtime`. Clients must ignore unknown
optional fields; that is how additive features ship within one protocol major.

## Errors

Live admission and runtime failures answer `{ "statusCode": <status>, "code": "<CODE>" }`
and never include state, tokens, identities, stack traces or thrown messages.
Application `HttpException`s and exception filters keep their own bodies; any other
thrown error becomes Nest's default `500 Internal server error`. The catalog is exported
as `LIVE_ERROR_CODES` (status, recovery, description) and a test checks that every code
the package can emit is listed with the status it is emitted with.

| Code                       | Status | Recovery    | Meaning                                                                  |
| -------------------------- | ------ | ----------- | ------------------------------------------------------------------------ |
| `INVALID_REQUEST`          | 400    | fix-request | Envelope failed strict schema validation.                                |
| `INVALID_CAPABILITIES`     | 400    | fix-request | Malformed x-nestvexa-capabilities header.                                |
| `UNEXPECTED_INPUT`         | 400    | fix-request | Input sent to an action or $sync that takes none.                        |
| `INVALID_STREAM_REFERENCE` | 400    | fix-request | Text stream reference is not a snapshot/revision pair.                   |
| `STREAM_REQUEST`           | 400    | fix-request | Text stream request body is invalid.                                     |
| `IDENTITY_REQUIRED`        | 401    | deny        | The host identity resolver returned no valid identity.                   |
| `ORIGIN_REJECTED`          | 403    | deny        | Origin header does not equal the configured origin.                      |
| `CSRF_REJECTED`            | 403    | deny        | x-nestvexa-csrf does not match the identity token.                       |
| `ACTION_FORBIDDEN`         | 403    | deny        | Host authorize policy refused this action or $sync.                      |
| `COMPONENT_FORBIDDEN`      | 403    | deny        | Host authorize policy refused $mount.                                    |
| `STREAM_FORBIDDEN`         | 403    | deny        | Host authorize policy refused `$stream:<id>`.                            |
| `COMPONENT_MISMATCH`       | 403    | deny        | The snapshot belongs to a different component route.                     |
| `IDENTITY_CHANGED`         | 403    | deny        | The identity changed while a stream was open.                            |
| `ADMISSION_REQUIRED`       | 403    | deny        | A handler ran without passing Live admission.                            |
| `UNKNOWN_ACTION`           | 404    | fix-request | The action is not registered on this component.                          |
| `DOWNLOAD_UNAVAILABLE`     | 404    | reload      | Download token unknown, expired, consumed or not owned.                  |
| `STREAM_METHOD`            | 405    | fix-request | Text streams accept POST only.                                           |
| `STALE_REVISION`           | 409    | resync      | The snapshot revision changed since the client rendered it.              |
| `COMPONENT_BUSY`           | 409    | retry-later | Another request for this component instance is running.                  |
| `ACTION_BUSY`              | 409    | retry-later | An identity-scoped action is already running for this identity.          |
| `IDEMPOTENCY_CONFLICT`     | 422    | fix-request | A request ID was reused with a different payload.                        |
| `STATE_SCHEMA_CHANGED`     | 409    | reload      | Stored state no longer matches the component class.                      |
| `REACTIVE_PROP_MUTATED`    | 409    | reload      | A child action changed a parent-owned @Reactive field.                   |
| `INVALID_SNAPSHOT`         | 410    | reload      | State reference unknown, expired, revoked or not owned.                  |
| `PAYLOAD_TOO_LARGE`        | 413    | fix-request | Envelope or rendered HTML exceeds the documented limits.                 |
| `CONTENT_TYPE`             | 415    | fix-request | Requests must be application/json (UTF-8).                               |
| `STATE_LOCKED`             | 422    | fix-request | An update named a field that is not writable public state.               |
| `STATE_TYPE`               | 422    | fix-request | An update changed the JSON kind of a field or failed its synthesizer.    |
| `STATE_INVALID`            | 422    | fix-request | A @State validate callback rejected the value.                           |
| `UNSUPPORTED_PROTOCOL`     | 426    | reload      | The envelope names another protocol major.                               |
| `RATE_LIMIT`               | 429    | retry-later | Per-identity request budget exhausted.                                   |
| `STREAM_CAPACITY`          | 429    | retry-later | Too many concurrent text streams.                                        |
| `INVALID_STATE`            | 400    | server      | The store was asked to create state for an invalid component identifier. |
| `INVALID_STORE_OPTIONS`    | 500    | server      | Store options, clock or generators are invalid.                          |
| `STREAM_AUTHORIZATION`     | 500    | server      | A stream producer ran without authorization.                             |
| `STREAM_HTTP_ADAPTER`      | 500    | server      | The HTTP adapter cannot stream responses.                                |
| `DOWNLOAD_CAPACITY`        | 503    | retry-later | Pending download capacity reached.                                       |
| `STORE_CAPACITY`           | 503    | retry-later | State or in-flight action capacity reached.                              |
| `LIVE_SHUTDOWN`            | 503    | retry-later | The application is shutting down.                                        |
| `STREAM_SHUTDOWN`          | 503    | retry-later | The application is shutting down streams.                                |
| `COMPUTED_TIMEOUT`         | 504    | retry-later | An async @Computed exceeded its deadline.                                |
| `HOOK_TIMEOUT`             | 504    | retry-later | A lifecycle hook exceeded the component timeoutMs.                       |
| `ACTION_TIMEOUT`           | 504    | retry-later | An action exceeded the component timeoutMs.                              |

Recovery values: **fix-request** (retrying the same bytes cannot succeed), **deny** (do
not retry automatically), **reload** (server state is gone; reload the page),
**resync** (refresh the component, let the user repeat the intent), **retry-later**
(transient; send a new request later), **server** (host or server fault). Failures after
component code started (hooks, action, render) also invalidate the state reference,
because external effects may already have happened; the next request gets `410`.

## Schemas and fixtures

`LIVE_REQUEST_SCHEMA`, `LIVE_RESPONSE_SCHEMA` and `LIVE_ERROR_SCHEMA` are frozen JSON
Schema (draft 2020-12) objects for non-JavaScript clients, gateways and contract tests.
The server validates with `parseLiveRequest`, which is stricter than the schema (byte,
depth and node budgets; canonical tokens; descriptor checks). Golden fixtures live in
`tests/fixtures/live-protocol/`; [the contract tests](../../tests/live-protocol-contract.test.ts)
validate them against both the schemas and the parser and fuzz the parser with seeded
mutations (it must return a frozen request or throw `LiveProtocolError`, never anything
else).

## Capability negotiation and versioning

- **Protocol major.** `protocol` names the major version. A server answers any other
  value with `426 UNSUPPORTED_PROTOCOL`; the client reloads. Majors change only for
  incompatible envelopes.
- **Capabilities.** Optional behaviour is requested per request with
  `x-nestvexa-capabilities: token[,token…]`, each token `name-vN` (lowercase, at most 16
  tokens, 512 characters). The server honours tokens listed in `LIVE_CAPABILITIES`
  (today `renderless-v1`) and ignores well-formed tokens it does not know, so newer
  clients keep working against older servers. Malformed headers fail admission with
  `400 INVALID_CAPABILITIES` before guards or component code run. A negotiated
  capability never changes the default response of a client that did not ask for it.
- **Advertisement.** Successful action and `$sync` replies carry
  `x-nestvexa-protocol: nestvexa-live/1` and `x-nestvexa-capabilities` (comma-separated
  `LIVE_CAPABILITIES`). The browser client reports another advertised major, or a `426`,
  as error code `PROTOCOL` and suspends the component; reloading is the recovery.
- **Idempotent marker.** The component wrapper lists `@Action({ idempotent: true })` ids
  in `data-nv-idempotent` (JSON array). The browser resends only those actions, byte for
  byte with the same `requestId`, after a dropped connection, timeout, `409`, `429`,
  `502`, `503` or `504` (two resends, full jitter); see
  [client transport](../guides/client-transport.md).
- **Evolution rules.** Additive response fields, new error codes and new capability
  tokens are minor changes. Removing or renaming a field, changing a status, or making
  an optional request field required is a new protocol major, shipped with a migration
  note and a reload path. Existing codes keep their status within a major.

## Action options

| Option                               | Behaviour                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `renderless: true`                   | With the `renderless-v1` capability, acknowledge state without rendering.                                                                                                                                                                                                                                                |
| `idempotent: true`                   | An identical retry (same identity, reference, `requestId`, revision, updates and input) of a committed action returns the stored response with `replayed: true` instead of `409`. The same `requestId` with another payload is `422 IDEMPOTENCY_CONFLICT`. Guards and pipes run again on the retry; the action does not. |
| `concurrency: 'component'` (default) | One request per component instance at a time (`409 COMPONENT_BUSY`).                                                                                                                                                                                                                                                     |
| `concurrency: 'identity'`            | Additionally at most one execution of this action per identity across all instances and tabs (`409 ACTION_BUSY`); the rejected request's state stays usable.                                                                                                                                                             |

Overlapping work is always rejected, never queued: a queued request would carry a stale
revision. Non-idempotent duplicates are rejected with `409 STALE_REVISION`, so a payment
or order action is never executed twice by a replayed request. Replays are kept for five
minutes, at most 1,000 per runtime (oldest evicted; an evicted retry fails safely with
`409`). Replays and identity locks are single-process; a multi-replica deployment needs
sticky sessions or a shared store (DATA-004/005). The browser runtime resends only actions listed in `data-nv-idempotent`, with the
same `requestId`; programmatic clients can use the same contract.

## Deadlines, cancellation and shutdown

`@LiveComponent({ timeoutMs })` (1–300000) bounds every lifecycle hook and the action
method. On expiry the request fails with `504 HOOK_TIMEOUT` or `504 ACTION_TIMEOUT`,
the state reference is invalidated and `liveAbortSignal(this)` aborts. Pass that signal
to `fetch`, database drivers or timers so work actually stops; Nestvexa cannot undo work
that already happened. On application shutdown every running operation's signal aborts,
new work answers `503 LIVE_SHUTDOWN`, and `beforeApplicationShutdown` waits up to ten
seconds for in-flight Live requests to settle before the HTTP server and store close.

## Limits

| Limit                                  | Value                                     | Error                      |
| -------------------------------------- | ----------------------------------------- | -------------------------- |
| Request envelope                       | 65,536 JSON bytes, depth 16, 5,000 nodes  | `413 PAYLOAD_TOO_LARGE`    |
| Rendered HTML (mount or update)        | 1 MiB                                     | `413 PAYLOAD_TOO_LARGE`    |
| Requests per identity                  | 60 per minute (`maxRequestsPerMinute`)    | `429 RATE_LIMIT`           |
| Rate-limit buckets                     | 1,000 identities per minute window        | `429 RATE_LIMIT`           |
| Stored component states (memory store) | 1,000 entries, 15-minute fixed expiry     | `503 STORE_CAPACITY`       |
| Child components                       | 200 per render tree, depth 8              | server error               |
| Capability header                      | 16 tokens, 512 characters                 | `400 INVALID_CAPABILITIES` |
| Events per action                      | 16, 16 KiB payload each                   | server error               |
| Flash messages per action              | 8                                         | server error               |
| Downloads                              | 5 MiB, single use, 60 s, 100 pending      | `503 DOWNLOAD_CAPACITY`    |
| Realtime channels per component        | 32, signer token at most 8,192 characters | server error               |
| Idempotent replays                     | 1,000 per runtime, 5 minutes              | evicted → `409`            |
| Identity-scoped action locks           | 10,000 concurrent                         | `503 STORE_CAPACITY`       |
| Component deadline (`timeoutMs`)       | 1–300,000 ms, default none                | `504`                      |
| Async computed deadline                | default 30 s, at most 300 s               | `504 COMPUTED_TIMEOUT`     |
| Shutdown drain                         | 10 s                                      | —                          |

`LIVE_LIMITS` exports the envelope budget. Configure the host body parser with a limit
at or below 64 KiB so oversized bodies are rejected before JSON parsing.

## Typed state

`@State({ synthesizer })` (alias `serializer`) converts a typed field to public JSON and
back. Built-ins: `DateSynthesizer`, `BigIntSynthesizer`, `enumSynthesizer(values)`,
`nullableSynthesizer(inner | 'string' | 'number' | 'boolean')`,
`setSynthesizer({ item?, maxItems? })` and `mapSynthesizer({ value?, maxItems? })`
(string keys, `[key, value]` pairs). `defineSynthesizer({ name, dehydrate, hydrate })`
declares a domain type. For writable synthesized fields the synthesizer's `hydrate`
decides which client JSON is accepted (`422 STATE_TYPE` otherwise), which is how a
`string | null` field can move between `null` and text. `@State({ default })` fills a
field the class leaves uninitialized (JSON cloned per instance, or a factory); it never
overrides restored state or client updates.
