# Live protocol and server state

The experimental `nestvexa-live/1` protocol uses an opaque, random server-state reference. It does not sign or encrypt a browser state snapshot. State is held in a bounded, single-process `MemoryLiveStore`; rendering may expose public state in HTML or response data, so never put secrets in public component fields.

## Request contract

A request has exactly these fields; `input` is optional. The token below is illustrative and must never be used as a production token.

```json
{
  "protocol": "nestvexa-live/1",
  "requestId": "d85e7c20-72ac-4e71-8baf-210dbe79e912",
  "snapshot": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "revision": 0,
  "updates": { "count": 2 },
  "input": null
}
```

`parseLiveRequest(unknown)` validates and returns a detached, deeply frozen envelope. `requestId` must be a standard UUID; it is a correlation identifier and, only for actions declared `@Action({ idempotent: true })`, the idempotency key (see the [protocol reference](../reference/live-protocol.md#action-options)). `snapshot` must be canonical unpadded base64url for exactly 32 bytes. `revision` must be a nonnegative safe integer. `updates` contains top-level state field identifiers, not executable expressions or dot paths. Whole nested JSON values may be supplied, subject to the component's writable-field policy. The host chooses the registered component/action route; this envelope cannot request arbitrary classes, methods or templates.

Unknown fields and non-JSON values fail validation. Accepted values are null, booleans, finite numbers, strings, dense arrays and plain objects. Date, BigInt, Map, Set, custom prototypes, functions, symbols, undefined, accessors, cycles and sparse/augmented arrays are rejected. The keys `__proto__`, `constructor` and `prototype` are rejected at every depth. Descriptor inspection does not invoke ordinary getters or `toJSON`; hostile JavaScript Proxy objects are outside the HTTP JSON trust boundary.

`cloneState(unknown)` applies the same structural rules, requires an object at the root and returns a detached mutable clone. The parser and store freeze their own copies. Repeated references are cloned independently; they are permitted when acyclic.

## Limits and transport obligations

| Boundary                             | Current limit                                 |
| ------------------------------------ | --------------------------------------------- |
| Encoded JSON request or public state | 65,536 UTF-8 bytes                            |
| Nesting depth                        | 16 edges from the root                        |
| Nodes                                | 5,000 values including containers and root    |
| Component name                       | Lowercase identifier, up to 64 characters     |
| Binding                              | Nonempty host string, up to 4,096 UTF-8 bytes |
| Transaction HTML result              | 1,048,576 UTF-8 bytes                         |

Byte accounting includes JSON quoting, escaped control characters, object keys and punctuation. The HTTP host must reject oversized bodies **before** JSON parsing; validating an already materialized object cannot limit network buffering or body-parser allocation. State limits apply again after every callback. Template rendering must escape untrusted content independently; the store's HTML limit is not an HTML sanitizer.

HTTP method, content type, allowed origin, cookie-bound CSRF token, authentication, authorization, rate limits and input schemas belong to the Nest admission/action integration. Calling the parser or store alone does not enforce them. Guards must resolve identity authoritatively on every request. Never use browser-submitted `userId`, tenant, or session strings as a binding.

## Model synchronization route

Each registered component also has a fixed `POST <endpoint>/<component>/_sync` route. The host must explicitly authorize the policy action `$sync`. It uses the same origin, session, CSRF, rate, snapshot ownership and revision admission checks as action requests. `input` must be absent or null. Global and component-class Nest policies apply; no action method or action-method guard/pipe/interceptor/filter metadata is borrowed. Protect access to component data and lifecycle/render work with the class/global policies and the host authorization callback.

Synchronization hydrates a request-scoped instance, applies validated writable state, dehydrates and renders it, then advances the revision. It never invokes action methods or `beforeAction`/`afterAction`. Lifecycle hooks and rendering are trusted application work and may still have effects; synchronization is not an automatically safe retry operation.

Both action and sync updates check writable fields, current JSON value types and optional pure `@State({ validate })` callbacks before entering the store transaction. Validators receive immutable detached JSON and must return `true` to accept it. A rejected update returns 422 without consuming the token or revision. Validator exceptions occur before the transaction and also leave the state usable. Hosts must keep validators bounded and free of side effects. The store rechecks ownership/revision when entering the transaction, so an asynchronous validator cannot overwrite a concurrent winning request. Failures after transaction entry retain the invalidation semantics below.

The illustrative `count` update above requires `@State({ writable: true })`; the counter example deliberately keeps count read-only to browser updates and changes it only through actions. See the [model directive reference](../reference/directives.md) and [Express/Fastify synchronization tests](../../tests/live-model.test.ts).

## Store contract

```ts
import { MemoryLiveStore } from '@nestvexa/live';

const store = new MemoryLiveStore({ ttlMs: 15 * 60_000, maxEntries: 1000 });
// Derive this from verified host session/principal/tenant context with unambiguous encoding.
const binding = JSON.stringify(['session-id', 'principal-id', 'tenant-id']);
const initial = store.create('counter', binding, { count: 0 });
const next = await store.transaction(
  initial.snapshot,
  binding,
  initial.revision,
  async (previous) => {
    const count = previous.state.count;
    if (typeof count !== 'number') throw new Error('Invalid counter state');
    return {
      state: { count: count + 1 },
      html: `<output>${count + 1}</output>`,
    };
  },
);
store.revoke(binding); // Host logout/session revocation hook.
```

The fixed binding strings above are explanatory; the host supplies real verified context. Counter numeric interpolation is safe in this narrow example; render general data through the configured engine.

`create(component, binding, state)` returns `{ id, name, revision, state, snapshot, expiresAt }`. IDs use random UUIDs. Tokens use `crypto.randomBytes(32)`. Binding values are stored only as SHA-256 digests and compared using `timingSafeEqual`; no binding is included in the returned snapshot. `peek(token, binding)` returns a separately cloned/frozen snapshot. `transaction(token, binding, revision, callback)` returns that snapshot plus `html`, after a successful callback and validation. The token remains stable across successful revisions; revision increments by one. Expiry is absolute from creation and is not extended by requests.

Default TTL is 15 minutes; configured TTL must be 1 ms through 24 hours. Default capacity is 1,000 entries; configured capacity must be 1 through 100,000. Full stores reject new state with 503 instead of silently evicting active users. Expired entries are removed on creation, lookup of that token, and `size` reads. There is no background timer. `delete(token)` and `clear()` are host-only cleanup methods. `revoke(binding)` removes every entry for exactly that binding. Application shutdown should clear the store.

Optional `now`, `randomToken` and `randomId` callbacks permit deterministic tests. Production must retain cryptographically secure generators and a trusted clock. Generator outputs are validated; duplicate active tokens fail instead of overwriting state. These options are not a way to turn human-readable identifiers into secure tokens.

## Concurrency, effects and failure semantics

The store checks ownership, expiry, expected revision and an in-memory lock synchronously before invoking the callback. Only one callback can run for a token at a time. Concurrent calls receive 409; stale replays receive 409 before any callback executes. Independent tokens may run concurrently. Callbacks receive immutable snapshots; return a new state object.

A callback failure, invalid return state, oversized rendered HTML, or expiry/revocation during execution invalidates that token. A later retry cannot repeat the callback using it. Revoked/deleted/cleared state cannot be resurrected when an old callback completes. Locks are released in `finally`.

This is **not** rollback of external effects or exactly-once delivery. A callback may commit a database mutation before rendering fails, a connection disconnects, or the token expires. The store cannot undo it. Database transactions, business idempotency keys and reconciliation belong to the host action. Do not automatically retry mutations after 409, 410, connection loss or an unknown result. Refresh/reconcile first. A new component token does not deduplicate earlier business operations.

Callbacks must honor host cancellation/timeouts; JavaScript cannot safely forcibly stop arbitrary callback effects. A separate execution ceiling permits at most `maxEntries` in-flight callbacks. Expiry, deletion, revocation or `clear()` does not release an execution slot until that callback settles. This prevents token churn from accumulating unbounded pending actions. When the execution ceiling is reached, new transactions receive 503 before their callbacks execute; their state remains valid. A never-settling callback can therefore exhaust capacity, requiring host timeout/recovery measures. This store has no multi-process coordination, durable storage, reconnect result replay, signing-key rotation, Redis adapter, or distributed locks. Multi-instance deployments require a separately implemented shared store; restarting the process loses all tokens.

## Error mapping

| Code                    | Status | Meaning                                                    |
| ----------------------- | ------ | ---------------------------------------------------------- |
| `INVALID_REQUEST`       | 400    | Malformed envelope or unsupported JSON data                |
| `INVALID_STATE`         | 400    | Invalid server component identifier                        |
| `PAYLOAD_TOO_LARGE`     | 413    | JSON structure/bytes or returned HTML exceeds limits       |
| `UNSUPPORTED_PROTOCOL`  | 426    | Client/server protocol mismatch; reload                    |
| `INVALID_SNAPSHOT`      | 410    | Unknown, expired, revoked, malformed, or wrong-owner token |
| `STALE_REVISION`        | 409    | Expected revision is stale or invalid                      |
| `COMPONENT_BUSY`        | 409    | Another callback is in flight for this token               |
| `STORE_CAPACITY`        | 503    | Stored-entry or in-flight callback capacity reached        |
| `INVALID_STORE_OPTIONS` | 500    | Invalid trusted configuration, clock or generator          |
| `STATE_LOCKED`          | 422    | Update targets a locked or unregistered state field        |
| `STATE_TYPE`            | 422    | Update changes the current JSON value category             |
| `STATE_INVALID`         | 422    | Application state validator rejects the update             |

Unknown/wrong-owner/expired tokens use the same public error. Callback exceptions propagate to the Nest error boundary, which must redact production errors. Never log raw snapshots, bindings, state, cookie values or action input by default.

## Evidence and compatibility

[Protocol/store tests](../../tests/live-protocol.test.ts) cover the wire fixture, byte/depth/node boundaries, Unicode, getters, prototypes, malformed input, expiry, owner/tenant swapping, race exclusion, stale replay, callback failure, revocation during execution and cache capacity. Run `pnpm exec vitest run tests/live-protocol.test.ts`. These are server contract tests; browser, Nest guard and transport evidence lives in the corresponding integration suites and is not implied by this suite.

This is an alpha protocol. A changed envelope or incompatible state interpretation requires a protocol/version migration and explicit reload behavior. Unsupported protocol versions are rejected rather than interpreted heuristically.

Design references: [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) explains opaque identifiers, entropy, binding and expiry; [Node crypto.randomBytes](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback) defines the cryptographic generator used here. Both were inspected during implementation. This design is not a claim of complete ASVS conformance or a substitute for external security review.

The complete request/response/error shapes, published JSON Schemas, error catalog, capability negotiation rules and limits table are in the [Live protocol reference](../reference/live-protocol.md).
