# 0036 — Server state references instead of signed snapshots; read-only refresh

Date: 2026-11-14. Status: **accepted; implemented** in `@nestvexa/live` and
`@nestvexa/client`. Relates to [ADR 0002](0002-live-protocol.md),
[ADR 0005](0005-state-and-concurrency.md),
[ADR 0031](0031-live-protocol-evolution-and-action-replay.md) and
[ADR 0032](0032-distributed-state-and-redis.md).

## Context

Section 7.2 of the specification lists the hazards of browser-held component
snapshots: canonicalization, envelope validation, "signatures/HMAC key
rotation", anti-replay, server-stored state, identity binding, expiry,
concurrency, deduplication, response ordering, retry policies and nesting
limits. It prefers server-side stored state for sensitive or large data and
asks to "differentiate non-mutating refresh from mutating actions".

Two questions were open after round 4:

1. Should `data-nv-snapshot` become a signed, browser-held state blob with HMAC
   key rotation (current and previous keys, a grace window, retired keys
   rejected)?
2. `$sync` and the `STALE_REVISION` recovery both ran a store transaction and
   advanced the revision, so there was no request that only reads.

## Decision 1: no signed browser snapshots

Nestvexa keeps **all** component state on the server (`LiveStateStore`:
`MemoryLiveStore` by default, `RedisLiveStore` for replicas). The browser holds
only `data-nv-snapshot`, a 256-bit random reference (`randomBytes(32)`,
base64url, 43 characters), and the revision it rendered. Signing that value
would add nothing:

- **Integrity.** The browser never sends state back, only a reference plus
  `updates` for fields declared writable. There is nothing to verify: a
  modified reference does not exist in the store (`410 INVALID_SNAPSHOT`), and
  every update is checked against the stored value (`STATE_LOCKED`,
  `STATE_TYPE`, `STATE_INVALID`, nested allowlists) before component code runs.
- **Unforgeability.** A reference is a capability with 256 bits of entropy; an
  HMAC tag would be a second unguessable value that proves the same thing.
- **Binding.** The store compares the host identity binding on every read
  (`peek`, `transaction`), so a stolen reference is useless to another
  identity or session. `RedisLiveStore` keys entries by `sha256(token)` and
  indexes them by `sha256(binding)`; raw references never reach Redis.
- **Replay and ordering.** The store, not the token, holds the revision:
  `transaction` is a compare-and-set, so a replayed or reordered request is
  `409 STALE_REVISION`, and idempotent actions replay their stored response
  (ADR 0031). A signature cannot prevent replay of a validly signed blob; the
  server-side revision does.
- **Expiry and revocation.** Entries carry a server TTL and `revoke(binding)`
  drops every entry of a session at logout. A signed blob would stay valid
  until its embedded expiry unless the server kept a revocation list, which is
  server state again.
- **Secrecy.** State is public by design (it is rendered into HTML), so the
  question is only integrity, which the server copy already guarantees.

Key rotation therefore applies where Nestvexa does use keys, and both follow
the same rule (first key signs or encrypts, every configured key verifies or
decrypts, removing a key retires it):

| Key                                        | Rotation                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Realtime subscription tokens (HMAC-SHA256) | `secrets: [current, previous]`; tokens expire in 15 minutes by default, so the previous secret can be removed after one token lifetime.                                                                                                                                                                                                                    | `tests/realtime.test.ts`, `tests/property-realtime-token.test.ts`                                |
| `RedisLiveStore` records at rest (AES-GCM) | `encryptionKeys: [current, previous]`. Open pages keep working during the grace window; every commit re-encrypts the record under the current key. After one store TTL (default 15 minutes) every live record has been re-encrypted or has expired, and the previous key can be retired. A record still sealed with a retired key fails closed with `410`. | `tests/live-store-contract.test.ts` ("rotates encryption keys without invalidating open pages…") |

Hosts that need browser-held state anyway (for example offline-first drafts)
keep it outside Live state; `@nestvexa/offline` owns that path.

### Rejected alternatives

- **Signed snapshot blobs with server revision tracking.** Every request
  would still need a server lookup for revision, binding and revocation, so
  the blob would duplicate the store and add canonicalization and key
  management risk.
- **Signing the reference.** Adds a key that must rotate, without changing
  what an attacker can do.

## Decision 2: a distinct read-only refresh

A `$sync` request marked `x-nestvexa-resync: 1` with empty `updates` is a
**read-only refresh**:

- It passes the same admission as every Live request (origin, content type,
  identity, CSRF, asset version, rate limit, envelope parse, reference
  ownership, component route, host authorization of `$sync`).
- It reads the stored entry with `peek`, never `transaction`: the revision,
  state, expiry and reference are unchanged, and a retry is always safe.
- It hydrates a fresh instance, runs `boot`, `hydrate` and `dehydrate`, and
  renders, so computed values and the template show current data. Effects
  queued by hooks (events, redirect, download, flash) are discarded, and no
  host session state is persisted.
- A successful refresh returns exactly the stored state. If a hook changed
  public state (for example a job status copied into `@State` in
  `dehydrate`), the refresh fails with `409 REFRESH_CONFLICT` and
  `x-nestvexa-recovery: commit`, because an action hydrates stored state and
  must see the same value the page shows. The first version of this change
  returned such state without storing it; the realtime browser suite caught
  the starter-live "Retry report" action reading a stale stored status, and
  the rule was tightened before merge.
- Children: a retained child whose props are unchanged is stubbed (the browser
  keeps its DOM). Mounting, removing or re-propping a child would create or
  change state, so the refresh fails with `409 REFRESH_CONFLICT` and
  `x-nestvexa-recovery: commit` before anything is created. Nothing is
  invalidated: the state stays usable.
- A failure never invalidates the reference (unlike a failed transaction):
  no revision was consumed.

`x-nestvexa-resync: commit` is the explicit mutating fallback: the pre-0036
behaviour, a transaction at the current revision with no updates and no
action, which may mount or remove children. Any other header value, any
update, or an action route is `400 INVALID_REQUEST`.

The browser client uses the read-only refresh for realtime invalidations of
components without a matching `@OnEvent` listener and for the `STALE_REVISION`
recovery; drafts stay local and go with the next request. On
`REFRESH_CONFLICT` it sends one committing resync. Model synchronization,
lazy first renders and actions remain mutating requests.

### Consequences

- Realtime fan-out (one invalidation, many subscribers) no longer writes one
  revision per subscriber; with `RedisLiveStore` a refresh costs one `GET`
  instead of about seven round trips.
- A refresh of an unchanged tree can no longer race a concurrent action into
  `COMPONENT_BUSY` or `STALE_REVISION`.
- Components that copy external data into `@State` in a hook pay one extra
  request (refresh, then commit) when that data changes; reading it through
  `@Computed` keeps the refresh read-only.

Evidence: `tests/live-refresh.test.ts` and `tests/live-stale-revision.test.ts`
(Express and Fastify), `tests/client-transport-lifecycle.test.ts`,
`tests/live-dependencies.test.ts`, `tests/browser/realtime.spec.ts`.
