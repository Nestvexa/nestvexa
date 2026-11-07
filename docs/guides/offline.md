# Offline drafts, read-only snapshots, safe reconnect and the action queue

`@nestvexa/offline` is an optional browser module for three progressive
behaviours, plus an opt-in queue for operations the server declares
idempotent (section 8 below). Drafts are never
replayed. The server stays authoritative, and every submit is an explicit user
action.

| Behaviour          | What the user sees                                                    | What never happens                         |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------ |
| Local drafts       | Typed values come back after a reload or crash, with a status message | Unmarked or sensitive fields being stored  |
| Interrupted submit | "Not sent. Your draft is saved on this device."                       | Automatic resubmission when back online    |
| Read-only snapshot | The last loaded region, inert, labelled with its save time            | A stale Live snapshot or CSRF token mounts |

It complements the core advisory indicator
[`nv:offline`](../reference/nv-offline.md), which shows connectivity hints
inside a component. Install details and every option are in the
[package README](../../packages/offline/README.md).

## 1. Render an identity-scoped namespace

Drafts are stored under an opaque hash of the current identity, so another
user on the same browser never sees them and logout can clear everything.

```ts
import { draftScope } from '@nestvexa/offline/server';

@Get('products')
@Render('products')
async products(@Req() request: SessionRequest) {
  return {
    draftScope: draftScope(draftSecret, `session:${request.sessionID}`),
    widget: await this.live.mount(ProductForm, request),
  };
}
```

```hbs
<meta name='nv-draft-scope' content='{{draftScope}}' />
```

Use a stable binding (user ID or session binding) and a secret of at least
32 bytes. Rotating the secret orphans old drafts; they expire or are purged.

## 2. Opt the form in, field by field

```hbs
<form
  data-nv-draft='product'
  data-nv-draft-message-restored='{{t "drafts.restored"}}'
  data-nv-draft-message-interrupted='{{t "drafts.interrupted"}}'
  data-nv-draft-message-reconnected='{{t "drafts.reconnected"}}'
  {{#if committedAt}}data-nv-draft-committed='{{committedAt}}'{{/if}}
  nv:submit='create'
>
  <p data-nv-draft-status role='status'></p>
  <label>Name <input name='name' nv:model='name' data-nv-draft-field /></label>
  <label>Price
    <input name='price' nv:model='price' inputmode='decimal' data-nv-draft-field />
  </label>
  <label>Contact email <input name='email' type='email' nv:model='email' /></label>
  <button type='submit'>{{t "products.create"}}</button>
</form>
```

- Only `name` and `price` are stored. The email field is not marked, which is
  the "no PII by default" rule. Password, file and hidden inputs and payment
  or one-time-code autocomplete fields are never stored, even when marked.
- Use the default (deferred) `nv:model`. Restoration dispatches `input` and
  `change`, which marks deferred fields dirty without sending a request. A
  `.live` model would synchronize state as it does for typing; that is a
  model update, never an action.
- Messages come from the server, so they can be translated with
  [`@nestvexa/i18n`](i18n.md).

## 3. Tell the module when the server accepted the form

After a successful action, render `data-nv-draft-committed` with an
epoch-millisecond timestamp. A changed token clears the draft. On a reload,
a token only clears drafts saved before it, so a newer draft survives.

```ts
@Action() create(): void {
  // …validate and persist through your service…
  this.committedAt = Date.now();
  this.name = '';
  this.price = '';
}
```

For forms without server markup, call `markCommitted(form)` from your own
code after the request succeeds.

## 4. Serve and attach the module

Serve `@nestvexa/offline/dist/index.js` from an explicit route under
`script-src 'self'`, then attach it from your own module:

```ts
import {
  attachOfflineDrafts,
  createDraftStore,
  createSnapshotCache,
  listenForLogout,
  loadRegion,
} from '/assets/offline.js';

const scope = document
  .querySelector('meta[name="nv-draft-scope"]')
  ?.getAttribute('content');
if (scope) {
  attachOfflineDrafts(document, { store: createDraftStore({ scope }) });
  listenForLogout();
  const activity = document.getElementById('recent-activity');
  const refresh = document.getElementById('refresh-activity');
  const cache = createSnapshotCache({ scope });
  refresh?.addEventListener('click', () => {
    if (activity)
      void loadRegion(activity, '/admin/activity', {
        cache,
        key: 'activity',
        label: refresh.dataset['offlineLabel'] ?? 'Offline copy',
      });
  });
}
```

## 5. The reconnect flow

1. The user submits while the network is down. The Live client reports a
   `nestvexa:error` with code `NETWORK` or `TIMEOUT` from the component.
2. The module keeps the draft, sets `data-nv-draft-state="interrupted"` and
   announces the interrupted message in the form's status element.
3. When the browser fires `online`, only the message changes ("Connection
   restored. Review and submit again."). Focus stays where it is.
4. The user reviews the values and presses submit again. Whether that works
   without a reload depends on what the client knows about the failed request:
   - **Not sent.** The browser reported itself offline (`navigator.onLine` was
     `false`), so the client never sent the request. The component stays
     usable; resubmitting after reconnect works without a reload.
   - **A refresh (`$sync`) without a response.** No action method runs on a
     refresh, so the component stays usable; unacknowledged field values stay
     dirty and travel with the next request.
   - **An action without a response while the browser believed it was
     online** (dropped connection, `TIMEOUT`). The action may have run on the
     server, so the component is suspended: further actions are rejected until
     the page reloads or the host remounts the component from authoritative
     markup. Drafts survive the reload.

   In every case the server validates the new request like any other. If an
   earlier request did commit, its revision makes the retry fail with
   `409 STALE_REVISION` (the component then suspends) instead of running the
   action twice.

Drafts are never replayed. Only operations you allowlist for the
offline action queue (section 8) are sent on reconnect;
purchases, payments and deletes cannot be allowlisted.

## 6. Logout clears drafts

```hbs
<form method='post' action='/logout' data-nv-logout>
  <button>{{t 'auth.logout'}}</button>
</form>
```

Submitting this form clears every draft (all scopes) and every snapshot in
this tab synchronously, broadcasts to other tabs (`BroadcastChannel` with a
storage-event fallback) and dispatches `nestvexa:logout`. Pages that called
`listenForLogout()` clear their own session-storage snapshots. For defense in
depth, the logout response can also send `Clear-Site-Data: "storage"`
(`clearSiteDataHeader` from `@nestvexa/offline/server`); browser support is
uneven, so do not rely on it alone.

## 7. Testing offline with Playwright

```ts
test('keeps the draft and never replays the submit', async ({
  page,
  context,
}) => {
  await page.goto('/admin/products');
  await page.getByLabel('Name').fill('Desk lamp');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('status')).toContainText('Not sent');
  await context.setOffline(false);
  // The submit was never sent (the browser was offline), so the component is
  // still usable; a reload is not required. The draft also survives one.
  await page.reload();
  await expect(page.getByLabel('Name')).toHaveValue('Desk lamp');
  // The server has not created the product until the user submits again.
});
```

The package's own suites run in real Chromium with a strict CSP:
[drafts](../../tests/offline-drafts.test.ts),
[snapshots](../../tests/offline-snapshot.test.ts),
[queue](../../tests/offline-queue.test.ts) and
[queue security](../../tests/offline-queue-security.test.ts). The
[offline/online replay test](../../tests/offline-queue-browsers.test.ts) runs
in Chromium, Firefox and WebKit.

## 8. Opt-in offline action queue

Some operations are safe to send later: saving a note, toggling a preference,
updating a profile field. Spec 16.2 allows queueing those, and only those, when
the server declares them idempotent. Purchases, payments and deletes stay
online-only.

### Declare the allowlist and guard the route

```ts
import {
  createOfflineReplayGuard,
  draftScope,
  offlineActionAllowlist,
} from '@nestvexa/offline/server';

export const offlineActions = offlineActionAllowlist([
  // The handler must be idempotent and run through the guard below.
  { id: 'notes.save', path: '/notes', label: 'Save note', idempotent: true },
]);
const replay = createOfflineReplayGuard({ allowlist: offlineActions });

@Post('notes')
async save(@Req() request: SessionRequest, @Res() response: Response) {
  // Runs after your session, CSRF and authorization checks.
  const result = await replay.run(
    {
      method: request.method,
      path: request.path,
      headers: request.headers,
      scope: draftScope(draftSecret, `user:${request.user.id}`),
      body: request.body,
    },
    async () => ({ status: 201, body: await this.notes.save(request.body) }),
  );
  response.set(result.headers).status(result.status).json(result.body);
}
```

- `offlineActionAllowlist` throws at startup unless every entry says
  `idempotent: true`, and refuses `DELETE`, safe methods and ids or paths that
  name payments, purchases, checkout, refunds, transfers or deletion.
- The guard executes each `Idempotency-Key` at most once per identity and
  action, answers duplicates with the stored 2xx result
  (`x-nestvexa-offline-replayed: 1`), refuses the same key with another body
  (`422 OFFLINE_KEY_REUSED`), refuses a queued entry of another identity
  (`403 OFFLINE_SCOPE_MISMATCH`) and refuses the offline headers on routes that
  are not allowlisted (`403 OFFLINE_NOT_ALLOWED`). Failed executions release
  the key so a retry runs again.
- With several replicas, pass a shared `OfflineReplayStore` whose `begin` is
  atomic (SET NX semantics).
- For `@nestvexa/actions`, `offlineServerAction(manifest.notes.save)` builds
  the definition and throws unless the action is
  `@ServerAction({ idempotent: true })`; the actions runtime then provides the
  deduplication.

### Render the allowlist and the queue UI

```hbs
<head>
  {{{offlineActionsMeta}}}
  {{! offlineActions.metaTag(), already escaped }}
  <meta name='nestvexa-csrf' content='{{csrfToken}}' />
</head>
<p
  data-nv-queue-status
  data-nv-queue-message-pending='{{t "queue.pending"}}'
  data-nv-queue-message-pending-one='{{t "queue.pendingOne"}}'
  data-nv-queue-message-sent='{{t "queue.sent"}}'
></p>
<ul data-nv-queue-list data-nv-queue-label-discard='{{t "queue.discard"}}'></ul>
<form data-nv-queue='notes.save' action='/notes' method='post'>
  <input type='hidden' name='_csrf' value='{{csrfToken}}' />
  <label>Title <input name='title' /></label>
  <button type='submit'>{{t 'notes.save'}}</button>
</form>
```

```ts
import { attachOfflineQueue, createOfflineQueue } from '/assets/offline.js';

const queue = createOfflineQueue({ scope });
attachOfflineQueue(document, { queue });
```

Submitting the form stores the entry (never the CSRF field) and sends it at
once, or when the browser comes back online. The status region announces the
pending count, a failure, expiry and success; the list shows each entry with
its state, time and a Discard button (and Try again after a failure).

### What the queue refuses

| Situation                                                         | Result                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Action not in the allowlist, or listed without `idempotent: true` | `NOT_ALLOWLISTED`; a form submits natively (`refused` message) |
| Form `action` differs from the allowlisted path                   | Submits natively                                               |
| Filled password, file, payment, one-time-code or secret field     | Submits natively; nothing is stored                            |
| `data-nv-sensitive` field with a value                            | Submits natively; nothing is stored                            |
| CSRF or `data-nv-queue-never` field                               | Dropped; the current CSRF token is sent at replay time         |
| More than `maxEntries` (20) or an entry over `maxBytes` (16 KiB)  | `QUEUE_FULL` / `TOO_LARGE`                                     |
| Entry older than `ttlMs` (1 hour)                                 | Removed unsent, announced as expired                           |
| Another identity's entries on this device, or logout              | Purged, never sent                                             |
| Redirect, 4xx or 5xx other than transient                         | Entry `failed`; the queue halts until discard or Try again     |
| Network error, timeout, 408/425/429/502/503/504                   | Retried with backoff and the same request ID                   |

### Test it offline

```ts
await context.setOffline(true);
await page.getByLabel('Title').fill('Groceries');
await page.getByRole('button', { name: 'Save' }).click();
await expect(page.getByRole('status')).toContainText('waiting to be sent');
await context.setOffline(false);
await expect(page.getByRole('status')).toHaveText(
  'All saved changes were sent.',
);
```

## Limits

- No service worker: a full page reload while offline is not supported.
- Snapshots live in session storage (per tab) for at most 24 hours.
- Conflict handling is "review and submit again"; there is no merge UI.
- The action queue replays only while a page that created it is open (no
  background sync), and the default replay store is per process.
- Local storage is readable by any script on the origin. Keep a strict CSP and
  never mark secrets as draft fields.
