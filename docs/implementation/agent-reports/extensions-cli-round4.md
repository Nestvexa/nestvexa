# Extensions and CLI, round 4

## EXT-014

Optional constrained offline action queue (spec 16.2). Branch
`r4-ext-offline-queue`. ADR: [0026 amendment](../../adr/0026-extensions-i18n-ui-ai.md).

### Implemented

- **Server allowlist** (`@nestvexa/offline/server`, `packages/offline/src/server/queue.ts`):
  `offlineActionAllowlist(definitions)` validates id, exact same-origin path,
  `POST`/`PUT`/`PATCH`, `form` or `action` (`@nestvexa/actions` `{ input }`)
  encoding and a literal `idempotent: true`. It refuses `DELETE`, safe methods,
  duplicates, accessor or unknown options, and ids or paths naming payments,
  purchases, checkout, refunds, transfers or deletion. It renders an escaped
  `<meta name="nv-offline-actions">`. `offlineServerAction(descriptor)` bridges
  only `@nestvexa/actions` descriptors declared `idempotent: true`. No change to
  `packages/core`, `packages/live`, `packages/client` or `packages/actions`.
- **Server dedupe**: `createOfflineReplayGuard({ allowlist, store?, ttlMs? })`.
  `run()` executes at most once per (identity scope, action, `Idempotency-Key`).
  Duplicates replay the stored 2xx outcome (`x-nestvexa-offline-replayed: 1`).
  The guard refuses: concurrent duplicates (`409 OFFLINE_IN_PROGRESS`), a reused
  key with another body (`422 OFFLINE_KEY_REUSED`), a scope that is not the
  session's (`403 OFFLINE_SCOPE_MISMATCH`), the offline header on a route that
  is not allowlisted (`403 OFFLINE_NOT_ALLOWED`), and missing or invalid keys
  (`400`). Failures and throws release the key. `MemoryOfflineReplayStore` is
  bounded, has a TTL (default and maximum 7 days), never evicts in-progress
  locks, and receives only SHA-256 digests. A pluggable `OfflineReplayStore`
  allows shared stores.
- **Browser queue** (`createOfflineQueue`, `packages/offline/src/index.ts`):
  - Only actions in the server meta with a literal `idempotent: true` can be
    queued (`NOT_ALLOWLISTED` otherwise).
  - Storage keys are `nv-queue:v1:<draftScope>:<requestId>`, the same identity
    namespace as drafts. Other identities' entries are purged on creation, and
    `announceLogout`/`listenForLogout` now clear `nv-queue` too.
  - Bounded (20 entries by default, max 100; 16 KiB per entry, max 256 KiB) and
    expiring (1 hour by default, max 24 hours). Expired entries are removed
    unsent and announced.
  - Records are revalidated on every read.
  - Secret-named fields (password, token, CSRF, session, OTP, card, key and so
    on) are refused. The CSRF token is never stored: it is read from
    `<meta name="nestvexa-csrf">` at each send.
  - Replay goes in order, one tab at a time (Web Locks), with the same request
    ID on every attempt, `redirect: 'manual'` and a per-attempt timeout.
    Network errors, timeouts, 408/425/429/502/503/504 and in-progress conflicts
    retry with exponential backoff. Any other failure, including redirects,
    halts the queue at that entry until the user discards it or tries again.
- **UI** (`attachOfflineQueue`):
  - `form[data-nv-queue]` capture drops CSRF and `data-nv-queue-never` fields.
    It refuses, and lets the form submit natively, when the action is not
    allowlisted, the form `action` does not match the path, or a filled
    password, file, `data-nv-sensitive`, secret-named or payment/OTP
    autocomplete field is present.
  - `[data-nv-queue-status]` gets `role="status"` and is written with
    textContent only.
  - `[data-nv-queue-list]` shows each entry's label, state, `<time>`, a Discard
    button, and Try again when the entry failed. Focus is kept in the list.
  - Messages and labels can be translated through `data-nv-queue-message-*`
    (with `-one` variants) and `data-nv-queue-label-*`.
  - Everything is built with DOM APIs, so it works under the strict CSP and
    never uses innerHTML.

### Tests

All tests run real browsers against the strict-CSP fixture server
(`tests/offline-support.ts`, now able to launch chromium, firefox or webkit, add
head markup and handle dynamic routes, on an ephemeral port). The queue fixture
(`tests/offline-queue-support.ts`) runs a real `createOfflineReplayGuard` behind
a CSRF check.

- `tests/offline-queue-server.test.ts` (security group, 13 tests, Node):
  - allowlist validation and refusals (non-idempotent, delete, payment,
    malformed), and escaped meta output;
  - actions bridge;
  - at-most-once execution and stored-outcome replay;
  - concurrent duplicates;
  - key reuse with another body;
  - non-allowlisted route carrying the replay header;
  - cross-identity scope;
  - key validation and passthrough;
  - key release after failure;
  - TTL expiry and memory bound;
  - hashed keys only;
  - option validation.
- `tests/offline-queue-security.test.ts` (security group, 10 tests, Chromium):
  - non-idempotent and unknown actions refused, with native submit;
  - path mismatch refused;
  - a tampered allowlist without a literal flag, or with `DELETE`/`GET`/`//`
    paths, is ignored;
  - secret-named programmatic fields refused;
  - filled password, payment, sensitive and file fields refuse the form and
    nothing is stored;
  - entry-count and byte bounds;
  - expiry dropped and announced, never sent;
  - another identity's entries purged and never sent;
  - server refuses a replay after the session identity changed;
  - logout purge;
  - tampered storage records dropped.
- `tests/offline-queue.test.ts` (integration group, 7 tests, Chromium):
  - form queueing without CSRF or never-fields, replayed with the current
    (rotated) CSRF token;
  - actions JSON envelope with PATCH;
  - ordered replay that halts at the first non-retryable failure and resumes
    after discard;
  - network abort and 503/429/409-in-progress retries with the same request ID;
  - redirect and CSRF failures are non-retryable, and the user can retry;
  - translated status and list, keyboard discard and focus management;
  - cross-tab sync through storage events.
- `tests/offline-queue-browsers.test.ts` (integration group, 3 tests): uses
  `context.setOffline(true)` to queue while offline, then
  `context.setOffline(false)` and checks that the entry replays exactly once
  with the same request ID. A duplicate delivery returns the stored outcome
  without running again, a reopened page sends nothing, and there are no CSP
  violations. It is parametrized over **Chromium, Firefox and WebKit**.
- `tests/offline-server.test.ts`: the browser export list now includes the
  queue exports.

Commands (worktree, after `pnpm --filter @nestvexa/offline... build`):
`pnpm exec vitest run tests/offline-queue-server.test.ts tests/offline-queue-security.test.ts tests/offline-queue.test.ts tests/offline-queue-browsers.test.ts tests/offline-drafts.test.ts tests/offline-server.test.ts tests/offline-snapshot.test.ts`.

### Docs

- `packages/offline/README.md`: the queue and server API, the markup contract,
  and the privacy section, which replaces "no offline action queue".
- `docs/guides/offline.md`: section 8 (allowlist, guard, UI, refusal table,
  Playwright example).
- `docs/adr/0026-extensions-i18n-ui-ai.md`: the amendment (threat model and
  decisions).
- `.changeset/offline-action-queue.md` (minor).

### Root package.json

- `test:integration` += `tests/offline-queue.test.ts tests/offline-queue-browsers.test.ts`.
- `test:security` += `tests/offline-queue-server.test.ts tests/offline-queue-security.test.ts`.
- No Playwright config entry: the browser test is vitest-driven and uses its
  own ephemeral-port fixture.

### Remaining gaps

- No example app wires the queue. Coverage comes from the fixture-based tests.
- No background sync or service worker: replay happens only while a page that
  created the queue is open.
- The default replay store is per process. Multi-replica hosts must supply an
  atomic shared `OfflineReplayStore`. No Redis implementation is shipped.
- For `offlineServerAction` routes, deduplication comes from the
  `@nestvexa/actions` idempotency store. The offline scope check applies only
  if the host also calls `guard.check()` in front of them, and no test covers
  an actions route end to end.
- Field-name secret detection is a heuristic word list. Hosts must still mark
  unusual sensitive fields `data-nv-sensitive`.
- Firefox and WebKit run only the offline-to-online replay test. The other
  queue suites run in Chromium.
