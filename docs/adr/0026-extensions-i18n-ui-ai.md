# 0026 — Optional extensions: i18n, UI kit, AI, feature flags and offline

Status: accepted for the current experimental implementation (Phase 14).

## Context

Phase 14 asks for internationalization with RTL, an accessible UI kit, offline
and progressive behavior, feature-flag-aware rendering and an AI streaming
adapter with human approval. Section 16 requires these to be real, testable,
optional packages that never pollute the default install. The core client has
a hard 48 KiB gzip budget (ADR 0020) and must not grow for optional features.
The HBS engine confines partials to the application's view root, and Live
components render through engine-level helpers only.

## Decision

1. **Five opt-in packages**, none a dependency of `nestvexa` or of any framework
   package (enforced by `scripts/boundaries.mjs`):
   `@nestvexa/i18n`, `@nestvexa/ui`, `@nestvexa/ai`, `@nestvexa/flags`,
   `@nestvexa/offline`. Browser code lives in each package's own single-file
   module (`@nestvexa/ui/browser`, `@nestvexa/ai/browser`, `@nestvexa/offline`),
   served by the host under `script-src 'self'`; it never imports Node, Nest or
   `@nestvexa/client`, so the core client size is unchanged.
2. **One small engine extension point**: `HbsEngine.registerHelpers()` adds
   trusted engine-wide helpers before initialization, and helpers now receive
   the Handlebars context as `this`. Optional packages plug into the
   umbrella-owned engine through this existing helper mechanism, without new
   umbrella options or a second template root.
3. **UI "partials" are trusted block helpers.** Shipping `.hbs` files inside
   `node_modules` would need copying or relaxing the view-root confinement. Block
   helpers render server markup with every attribute escaped, closed id grammar,
   same-origin link validation, and bodies from the application's own template
   via `options.fn(this)`. They behave the same in MVC pages and Live views.
   Interactive behavior follows the WAI-ARIA APG and uses native elements where
   they already are accessible (`<dialog>` + `showModal()`, `<details>`,
   `<progress>`).
4. **Locale is request context, not state.** `I18n.forRequest(request)`
   negotiates query → cookie → `Accept-Language` → default against an explicit
   allowlist on every request. Live components expose it through a `@Computed`
   value, so it is never stored in a snapshot, never client-writable and never an
   input to `authorize`. Pages set `Content-Language` and
   `Vary: Accept-Language, Cookie`. Text direction is derived from the locale
   and only affects markup (`dir`) and logical CSS.
5. **Flags are a separate package** because they are server-enforced capability
   checks used by guards and Live policies, not a UI concern. Evaluation fails
   closed, names are a closed allowlist, rendering uses a per-request snapshot,
   and `liveFlagPolicy` checks the flag before the host allowlist for every Live
   request including `$mount` and streams. `flagFingerprint` exists for shared
   cache keys.
6. **AI reuses the authorized text-stream transport.** No new protocol: the
   stream carries text only; tool-call status lives in server-side conversation
   state read by an ordinary authorized Live action. A tool call becomes a single
   pending approval bound to identity and conversation with a random 128-bit id,
   consumed before execution (replay and concurrent double approval execute at
   most once), re-authorized at approval time, with timeouts, cancellation and
   content-free audit events. Only a deterministic, labeled `TestProvider` ships;
   connecting a real provider is documented, not bundled.
7. **Offline is drafts plus read-only copies, never replay.** Drafts are opt-in
   per field, exclude secrets and hidden inputs, are namespaced by a server HMAC
   of the identity, expire, and are cleared on logout through an explicit API,
   `BroadcastChannel` and optional `Clear-Site-Data`. Interrupted submits keep the
   draft and change a message; reconnecting only changes the message again.
   Snapshots are stripped of scripts, handlers, Live markers and hidden inputs
   and restored `inert`.

## Rejected alternatives

- **Adding the extensions to the umbrella** — violates the opt-in rule and the
  client budget.
- **A second partial root or copying `.hbs` files** — weakens view-root
  confinement or creates drift between copies.
- **Storing the locale in Live state or URL state** — would mix presentation into
  snapshots and invite trusting a client-supplied locale.
- **A new AI wire protocol with structured envelopes** — would duplicate the
  bounded, revalidated text-stream transport; structured status is already
  available through Live state.
- **An offline action queue or automatic replay on reconnect** — section 16.2
  forbids blind replay; no idempotent allowlist exists yet.
- **A service worker** — caching authenticated HTML in Cache Storage needs a
  privacy/logout design of its own; deferred.

## Consequences and limits

- Optional browser modules are served and versioned by the host; they are not
  part of the content-addressed core asset catalog.
- ICU support is a documented subset; translation extraction is regex based.
- UI kit coverage is partial (no datepicker, uploader, drawer, wizard, popover,
  chart wrapper, table selection/filtering); the combobox needs JavaScript and the
  example adds a `<noscript>` select.
- AI conversations, approvals and flag rules are in-process; multi-instance
  deployments need shared implementations of those stores.
- Without a service worker a full page reload while offline is not supported.
- Automated axe checks run in three browsers; manual screen-reader testing is a
  documented checklist ([accessibility checklist](../testing/accessibility-checklist.md))
  that has not been executed by the implementing agent.

See the guides: [i18n](../guides/i18n.md), [UI kit](../guides/ui-kit.md),
[AI](../guides/ai.md), [offline](../guides/offline.md).

## Amendment (2026-11-06): `@nestvexa/mail`

The email/notification bridge (spec 16.5, EXT-029) follows the same rules as a
sixth opt-in package, listed in the boundaries extension list. It is a bridge, not
a provider: it renders mail views through the host's existing view engine (typed
structurally against `render(view, model, options)`, so it has no workspace or
engine dependency), validates messages against header injection, and delivers
through a provider-neutral `MailTransport` implemented by the host's nodemailer
transporter or `@nestjs-modules/mailer` `MailerService` (both typed structurally).
The console and memory transports deliver nothing and refuse production. See the
[mail guide](../guides/mail.md).

## Amendment (2026-11-07): offline action queue (EXT-014)

Spec 16.2 allows an optional, constrained offline queue for allowlisted
idempotent operations only, with explicit security and data expiry, and forbids
blindly replaying purchases, payments or deletes on reconnect. The earlier
rejection above ("no idempotent allowlist exists yet") is superseded by an
opt-in queue in `@nestvexa/offline`. Nothing changes for applications that do
not create one: drafts still never replay.

**Threat model.** (1) A page or attacker-controlled markup tries to queue an
operation the server never agreed to replay. (2) A replayed request executes
twice (network retry, two tabs, a duplicate delivery, a crafted resend).
(3) Secrets persist in device storage (passwords, tokens, CSRF values, payment
data, files). (4) Another user of the same device sends, or sees, the previous
user's queued entries. (5) An old entry is sent long after the user forgot about
it, or storage is tampered with to inject an entry. (6) A replay is taken as
success while the session has expired (redirect to login).

**Decisions.**

- _Server-declared allowlist._ `offlineActionAllowlist()` in
  `@nestvexa/offline/server` validates each definition (id, exact same-origin
  path, `POST`/`PUT`/`PATCH` only, `form` or `@nestvexa/actions` JSON encoding)
  and requires a literal `idempotent: true`. `DELETE`, safe methods and ids or
  paths naming payments, purchases, checkout, refunds, transfers or deletion are
  refused at startup (a speed bump, not the boundary). The page carries the list
  in `<meta name="nv-offline-actions">`; the browser ignores any entry without
  the literal flag and refuses to queue anything not listed, so an unlisted form
  submits natively. `offlineServerAction()` bridges only `@nestvexa/actions`
  descriptors declared `idempotent: true`. No core, live or client API changed.
- _Server-side deduplication._ `createOfflineReplayGuard()` wraps the handler.
  A request carrying the offline scope header to a non-allowlisted route is
  refused (`403 OFFLINE_NOT_ALLOWED`). On an allowlisted route the
  `Idempotency-Key` executes at most once per (identity scope, action, key):
  concurrent duplicates get `409 OFFLINE_IN_PROGRESS`, a reused key with another
  body `422 OFFLINE_KEY_REUSED`, a queued scope that is not the current session's
  `403 OFFLINE_SCOPE_MISMATCH`, and a completed key replays its stored 2xx
  outcome with `x-nestvexa-offline-replayed: 1`. Failures and throws release the
  key so a retry can run. Keys reach the store only as SHA-256 digests; the
  default store is process-local and bounded with a TTL (default and maximum
  7 days), and `OfflineReplayStore` lets replicas share an atomic store.
- _Browser queue._ `createOfflineQueue()` stores entries in `localStorage` under
  `nv-queue:v1:<draftScope>:<requestId>`, reusing the draft identity namespace;
  entries of any other scope are purged on creation, and `announceLogout()` /
  `listenForLogout()` clear the queue prefix too. Bounds: 20 entries (max 100),
  16 KiB per entry (max 256 KiB), TTL 1 hour (max 24 hours). Expired entries are
  removed unsent and announced (`expired` event and status text). Every stored
  record is revalidated on read (scope, id format, lifetime, field names and
  values), so tampered records are dropped.
- _No secrets._ Programmatic entries with password, token, CSRF, session,
  one-time-code, payment or key-named fields are refused. Form capture drops
  CSRF fields and `data-nv-queue-never` fields, and refuses (native submit) a
  form whose password, file, `cc-*`/password/one-time-code autocomplete,
  secret-named or `data-nv-sensitive` field has a value, because sending it
  without that field would change its meaning. The CSRF token is read from
  `<meta name="nestvexa-csrf">` (or a callback) at each send and never stored.
- _Replay._ In order, one tab at a time (Web Locks when available), with the
  original request ID on every attempt. Network errors, timeouts and 408, 425,
  429, 502, 503, 504 and in-progress conflicts retry with exponential backoff;
  any other failure, including any redirect (`redirect: 'manual'`), halts the
  queue at that entry until the user discards it or tries again.
- _Visible and accessible._ `attachOfflineQueue()` renders a `role="status"`
  region (pending count, sending, failed, sent, expired, refused, discarded)
  and a list with per-entry state, time, Discard and Try again buttons, using
  `textContent` and DOM APIs only (strict CSP, no inline script or style). Text
  is translatable through `data-nv-queue-message-*` (with `-one` variants) and
  `data-nv-queue-label-*`, like the draft messages.

**Limits.** Identity at replay time is the current session's cookie; the scope
check needs the host to pass `draftScope()` of the authenticated identity to the
guard. The memory replay store is per process. Routes bridged with
`offlineServerAction()` rely on the `@nestvexa/actions` idempotency store for
deduplication; add `guard.check()` in front of them to also enforce the scope
header. There is still no service worker, so a page must be open (and the queue
created) for replay to happen. See the [offline guide](../guides/offline.md).
