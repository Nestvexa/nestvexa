# @nestvexa/offline

Optional progressive/offline helpers for Nestvexa Live and plain HTML forms:

- **Opt-in local drafts** for forms, namespaced per identity hash, with a TTL,
  no PII by default and explicit clearing on logout.
- **Read-only HTML snapshots** of the last rendered region, shown as an inert,
  labelled copy when a refresh fails because the network is unavailable.
- **A safe reconnect flow**: an interrupted submit keeps the draft and tells
  the user. When the connection returns, only the message changes. Nothing is
  replayed, re-submitted or retried automatically.

Alpha software. The package is **not** part of the `nestvexa` default install
and adds nothing to the 48 KiB core client budget; it is a separate browser
module you serve yourself.

## Installation

After owner-authorized publication: `npm install @nestvexa/offline`,
`pnpm add @nestvexa/offline` or `yarn add @nestvexa/offline`. Before
publication, use the workspace package or packed tarballs.

- Node `^22.13.0 || ^24.0.0`, ESM only.
- No runtime dependencies and no peer dependencies.
- Entry points:
  - `@nestvexa/offline` — browser module (`dist/index.js`, one self-contained
    file with no imports, safe to import in Node because it touches no browser
    global at evaluation time).
  - `@nestvexa/offline/server` — Node helpers (`draftScope`,
    `clearSiteDataHeader`).

## Minimal usage

Server (Nest controller rendering an HBS page):

```ts
import { draftScope } from '@nestvexa/offline/server';

// DRAFT_SECRET: ≥32 bytes from your secret store; identity: your session/user binding.
return {
  draftScope: draftScope(process.env['DRAFT_SECRET'] ?? '', identity),
};
```

```hbs
<meta name='nv-draft-scope' content='{{draftScope}}' />
<form
  data-nv-draft='product'
  data-nv-draft-message-restored='{{t "drafts.restored"}}'
  data-nv-draft-message-interrupted='{{t "drafts.interrupted"}}'
  data-nv-draft-message-reconnected='{{t "drafts.reconnected"}}'
  nv:submit='save'
>
  <p data-nv-draft-status role='status'></p>
  <label>Name <input name='name' nv:model='name' data-nv-draft-field /></label>
  <label>Email <input name='email' type='email' /></label>
  <button type='submit'>Save</button>
</form>
<form method='post' action='/logout' data-nv-logout>
  <button>Log out</button>
</form>
<script type='module' src='/assets/offline.js'></script>
```

Serve `node_modules/@nestvexa/offline/dist/index.js` from an explicit route
(for example `/assets/offline.js`) under `script-src 'self'`, then attach it
from your own module:

```ts
import {
  attachOfflineDrafts,
  createDraftStore,
  listenForLogout,
} from '/assets/offline.js';

const scope = document
  .querySelector('meta[name="nv-draft-scope"]')
  ?.getAttribute('content');
if (scope) {
  attachOfflineDrafts(document, { store: createDraftStore({ scope }) });
  listenForLogout();
}
```

Only `name` is stored above: the email field is not marked
`data-nv-draft-field`.

## Markup contract

| Attribute                                | Meaning                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-nv-draft="<id>"` on `<form>`       | Opt the form in. `id` matches `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`.                                                                                                    |
| `data-nv-draft-field` on a field         | Save this field. Unmarked fields are never stored.                                                                                                                  |
| `data-nv-draft-never`                    | Never store this field, even when marked.                                                                                                                           |
| `data-nv-draft-status` (inside the form) | Receives status text via `textContent`. Give it `role="status"`.                                                                                                    |
| `data-nv-draft-message-<kind>`           | Server-translated text for `restored`, `interrupted`, `reconnected`.                                                                                                |
| `data-nv-draft-state` (set by module)    | `restored`, `interrupted` or `reconnected`; removed on reset.                                                                                                       |
| `data-nv-draft-committed="<token>"`      | Rendered by the server after it accepted the form. A new token clears the draft. Use an epoch-millisecond timestamp so a reload only clears drafts saved before it. |
| `data-nv-logout` on a form or control    | Clears all drafts and snapshots synchronously on submit/click, then lets navigation proceed.                                                                        |

Fields that are **never** stored, even when marked: `password`, `file` and
`hidden` inputs, buttons, disabled fields, and fields whose `autocomplete`
contains `cc-*`, `current-password`, `new-password` or `one-time-code`.

## Public API (browser, `@nestvexa/offline`)

### `createDraftStore(options): DraftStore`

| Option     | Default               | Notes                                                                       |
| ---------- | --------------------- | --------------------------------------------------------------------------- |
| `scope`    | required              | Opaque identity hash, `/^[A-Za-z0-9_-]{16,128}$/` (use `draftScope`).       |
| `storage`  | `window.localStorage` | Any `Storage`. Unavailable or throwing storage degrades to a no-op.         |
| `ttlMs`    | 24 hours              | 1 second to 7 days.                                                         |
| `prefix`   | `nv-draft`            | `/^[a-z][a-z0-9-]{0,31}$/`. Keys are `<prefix>:v1:<scope>:<form>`.          |
| `maxBytes` | 32 KiB                | Per serialized draft; larger drafts are not stored (reported to `onError`). |
| `now`      | `Date.now`            | Clock injection for tests.                                                  |
| `onError`  | none                  | Receives storage failures (`QuotaExceededError`, `SecurityError`, …).       |

`DraftStore` methods: `save(form, fields)`, `load(form)` (returns a frozen
`DraftRecord` or `null`; expired, corrupt, foreign-scope, oversize or
prototype-key records are removed), `clear(form)`, `purge()` (removes expired
drafts and every draft of any other scope under the prefix; returns the
count), `clearAll()` (every draft under the prefix, all scopes). Field values
are `string`, `string[]` (≤256) or `boolean`; at most 128 fields.

### `attachOfflineDrafts(root, options): OfflineController`

`root` is a `Document` or `Element`. Options: `store` (required), `window`,
`debounceMs` (400, 0–10000), `messages` (`restored`, `interrupted`,
`reconnected` fallbacks; the form's `data-nv-draft-message-*` attributes take
precedence). Behaviour:

- Purges expired and foreign-scope drafts on attach.
- Saves marked fields on `input`/`change` (debounced), immediately on submit
  and on `pagehide`. When every marked field is back at its default value the
  draft is removed.
- Restores a draft into a form whose marked fields are all at their defaults
  (initially, on `refresh()`, and for forms inserted later via a
  `MutationObserver`, for example after a Live morph). Restoration writes
  values and dispatches bubbling `input` then `change` events per changed
  field, so a deferred `nv:model` marks them dirty. It never submits, clicks
  or calls a Live action. A non-deferred `nv:model.live` field will
  synchronize its state as for any typing, which is a model update rather
  than an action.
- Reconnect: when a `nestvexa:error` event with code `NETWORK` or `TIMEOUT`
  bubbles from a component containing a draft form whose submit was attempted
  in the last two minutes, the draft is kept and the form becomes
  `interrupted`. The `online` event only switches the message to
  `reconnected`; focus is not moved and nothing is resent. A later
  `nestvexa:updated` from that component resets the state.
- Commit: a new `data-nv-draft-committed` token clears the draft.
- Logout: `data-nv-logout` controls call `announceLogout()`; after any
  `nestvexa:logout` event the controller stops saving for the rest of its
  life.

`refresh()` re-inspects forms; `dispose()` flushes pending saves, then removes
every listener and the observer.

### `markCommitted(form)`

Sets `data-nv-draft-committed` to the current time for forms that do not
receive server markup (for example after a successful `fetch`).

### `clearAllDrafts(storage?, prefix?): number`

Removes every draft under the prefix (default `nv-draft`) for all scopes.

### `announceLogout(options?): number` and `listenForLogout(options?): () => void`

`announceLogout` clears all drafts (local storage, `nv-draft`) and snapshots
(session storage, `nv-snapshot`) in this tab, posts to the
`nestvexa-logout` `BroadcastChannel`, writes and removes a storage signal key
as a fallback for other tabs, and dispatches `nestvexa:logout` on the window.
`listenForLogout` performs the same clearing when another tab announces, at
most once per announcement, and returns an unsubscribe function. Options:
`window`, `storage`, `prefix`, `snapshotStorage`, `snapshotPrefix`, `channel`.

### `createSnapshotCache(options): SnapshotCache`

Options: `scope` (required), `storage` (`window.sessionStorage`), `ttlMs`
(1 hour, max 24 hours), `prefix` (`nv-snapshot`), `maxBytes` (256 KiB),
`now`, `onError`.

- `remember(key, element)` stores a sanitized copy of the element's children.
- `restore(key, target, { label? })` replaces `target`'s children with a
  `role="region"` wrapper carrying `data-nv-offline-copy` and `aria-label`, a
  visible banner (`label` plus a `<time datetime>` of the save time) and an
  `inert`, `aria-readonly` body whose controls are disabled. Returns `false`
  for missing, expired, foreign or corrupt records.
- `clear(key?)` removes one snapshot or every snapshot of this scope.

Sanitization (on store **and** again on restore, because storage is not a
trusted channel) removes `script`, `iframe`, `object`, `embed`, `template`,
`link`, `meta`, `style`, `base`, `noscript`; every `on*`, `style` and `srcdoc`
attribute; `javascript:`, `vbscript:` and `data:` URLs; every `data-nv-*`,
`nv:*`, `x-*` and `@*` attribute (so the Live client and Alpine never adopt a
stale snapshot or token); hidden inputs and CSRF-named fields; form `action`,
`formaction` and `autofocus`.

### `loadRegion(target, url, options): Promise<'network' | 'cache' | 'unavailable'>`

Fetches a same-origin absolute path (`/…`, not `//…`, no backslashes or
control characters) with `credentials: 'same-origin'` and `Accept: text/html`.
On success the fragment is inserted after removing scripts, inline handlers
and unsafe URLs (Live markers are kept so a mounted client can adopt them),
then remembered. A rejected fetch (offline, DNS, reset) restores the cached
read-only copy. HTTP errors, non-HTML responses, cross-origin final URLs and
bodies over 1 MiB return `unavailable` and never fall back to a cached copy,
so a 401 after logout cannot reveal stale content. Options: `cache`, `key`,
`fetch`, `label`, `signal` (an aborted signal rethrows).

## Public API (server, `@nestvexa/offline/server`)

- `draftScope(secret, identity): string` — HMAC-SHA256 of
  `nestvexa-draft-scope:v1:<identity>` with a ≥32-byte secret, base64url,
  32 characters. Not reversible and not an authenticator. Rotating the secret
  orphans existing drafts; they expire or are purged on the next attach.
- `clearSiteDataHeader` — `{ name: 'Clear-Site-Data', value: '"storage"' }`
  for logout responses. Defense in depth only: WebKit support is partial, so
  `announceLogout()` / `data-nv-logout` remain the primary mechanism.

## Privacy and security

- Drafts are opt-in per field; nothing is stored by default and sensitive
  inputs are excluded even when marked. Keep PII out of drafts unless your
  privacy policy covers device storage.
- `localStorage` is readable by any script on the origin. A successful XSS can
  read drafts; never mark secrets, tokens or payment data. Keep a strict CSP.
- The namespace is an identity hash, not the identity. A shared device still
  holds drafts until TTL, logout or purge; logout clears all scopes.
- No action is ever replayed. There is deliberately **no offline action
  queue**: section 16.2 of the master plan allows queueing only allowlisted
  idempotent operations, and none is implemented here.
- Restored snapshots are inert and carry no Live snapshot, CSRF token or form
  target.

## Accessibility

Status text is written with `textContent` into your `role="status"` element,
so screen readers announce restoration, interruption and reconnection without
moving focus. The snapshot region is labelled and shows its save time as
visible text. Translate every message through the `data-nv-draft-message-*`
attributes.

## Testing

```sh
pnpm --filter @nestvexa/offline build
pnpm exec vitest run tests/offline-
```

The suites run in real Chromium against a strict-CSP fixture server:
[drafts](../../tests/offline-drafts.test.ts),
[snapshots](../../tests/offline-snapshot.test.ts),
[server helpers](../../tests/offline-server.test.ts). See also the
[offline guide](../../docs/guides/offline.md) and the core advisory
indicator [`nv:offline`](../../docs/reference/nv-offline.md).

## Production caveats

- **No service worker.** Reloading a page while fully offline shows the
  browser's own error page; snapshots only help within an already loaded page.
- Conflict handling is limited to "review and submit again": the server stays
  authoritative and validates the resubmitted form as any other request.
- The commit marker compares a server timestamp to the client clock on first
  sight; large clock skew can keep or clear one draft unexpectedly.
- `BroadcastChannel` and storage events only reach tabs of the same origin
  and browser profile.

## Compatibility

Evergreen Chromium, Firefox and WebKit (uses `inert`, `MutationObserver`,
`BroadcastChannel` when available, `TextEncoder`, `crypto.getRandomValues`).
Changes follow [the changelog](../../CHANGELOG.md).
